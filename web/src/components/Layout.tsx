import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banknote,
  Bell,
  Building,
  Check,
  ChevronsUpDown,
  Loader2,
  Building2,
  CalendarDays,
  CalendarPlus,
  ClipboardList,
  FileText,
  HandCoins,
  History,
  KeyRound,
  LayoutGrid,
  Layers,
  LogOut,
  Menu,
  Plug,
  MessagesSquare,
  ReceiptText,
  Scale,
  Search,
  Settings2,
  Tags,
  UserRound,
  UserRoundCheck,
  Users,
  UsersRound,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth, type Permission } from '../lib/auth';
import { relative } from '../lib/format';
import { Avatar, Field, FormError, ICON, Modal, Toaster, toast } from './ui';

type NavItem = { to: string; label: string; icon: ReactNode; perms?: Permission[]; count?: keyof NavCounts; self?: boolean; superAdmin?: boolean };
type NavCounts = { pipeline: number; documents: number; leave: number };

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '',
    items: [{ to: '/', label: 'Dashboard', icon: <LayoutGrid {...ICON} />, perms: ['dashboard.view'] }],
  },
  {
    group: 'My space',
    items: [
      { to: '/me/profile', label: 'My profile', icon: <UserRound {...ICON} />, self: true },
      { to: '/me/leave', label: 'My leave', icon: <CalendarPlus {...ICON} />, self: true },
      { to: '/me/payslips', label: 'My payslips', icon: <ReceiptText {...ICON} />, self: true },
    ],
  },
  {
    group: 'Recruitment',
    items: [
      { to: '/recruitment/pipeline', label: 'Pipeline', icon: <Layers {...ICON} />, perms: ['recruitment.view'], count: 'pipeline' },
      { to: '/recruitment/candidates', label: 'Candidates', icon: <UsersRound {...ICON} />, perms: ['recruitment.view'] },
      { to: '/recruitment/interviews', label: 'Interviews', icon: <MessagesSquare {...ICON} />, perms: ['recruitment.view'] },
    ],
  },
  {
    group: 'People',
    items: [
      { to: '/employees', label: 'Employees', icon: <Users {...ICON} />, perms: ['employees.view', 'team.view'] },
      { to: '/departments', label: 'Departments', icon: <Building2 {...ICON} />, perms: ['employees.manage'] },
      { to: '/documents', label: 'Documents', icon: <FileText {...ICON} />, perms: ['employees.view', 'documents.manage'], count: 'documents' },
    ],
  },
  {
    group: 'Payroll',
    items: [
      { to: '/payroll/runs', label: 'Payroll runs', icon: <Banknote {...ICON} />, perms: ['payroll.view'] },
      { to: '/payroll/structures', label: 'Salary structures', icon: <Scale {...ICON} />, perms: ['payroll.view'] },
      { to: '/payroll/loans', label: 'Loans and advances', icon: <HandCoins {...ICON} />, perms: ['payroll.view'] },
      { to: '/payroll/settings', label: 'Payroll rules', icon: <Settings2 {...ICON} />, perms: ['payroll.manage', 'settings.manage'] },
    ],
  },
  {
    group: 'Leave',
    items: [
      { to: '/leave/requests', label: 'Requests', icon: <CalendarDays {...ICON} />, perms: ['leave.view', 'leave.approve', 'leave.approve.team'], count: 'leave' },
      { to: '/leave/balances', label: 'Balances', icon: <ClipboardList {...ICON} />, perms: ['leave.view', 'leave.manage', 'leave.approve.team'] },
      { to: '/leave/types', label: 'Leave types', icon: <Tags {...ICON} />, perms: ['leave.manage'] },
    ],
  },
  {
    group: 'Admin',
    items: [
      { to: '/admin/users', label: 'Users and roles', icon: <UserRoundCheck {...ICON} />, perms: ['users.manage'] },
      { to: '/admin/audit', label: 'Audit trail', icon: <History {...ICON} />, perms: ['audit.view'] },
      { to: '/admin/integrations', label: 'Integrations', icon: <Plug {...ICON} />, perms: ['integrations.manage'] },
      { to: '/admin/companies', label: 'Companies', icon: <Building {...ICON} />, superAdmin: true },
    ],
  },
];

/**
 * The company this session works in. Super admins open a list to switch;
 * the page then reloads so nothing from the previous company stays in view.
 */
function CompanySwitcher() {
  const { user, company, companies, switchCompany } = useAuth();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const name = company?.name ?? 'HRMS';
  const mark = (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-ink text-xs font-semibold text-white">{name.charAt(0)}</span>
  );
  const away = !!user && user.companyId !== user.homeCompanyId;

  if (!user?.isSuperAdmin || companies.length < 2) {
    return (
      <div className="flex min-w-0 items-center gap-2 px-2">
        {mark}
        <span className="truncate text-[15px] font-semibold">{name}</span>
        <span className="text-[15px] text-ink-3">HRMS</span>
      </div>
    );
  }

  return (
    <div className="relative min-w-0 flex-1" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-raised"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch company"
      >
        {mark}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-tight">{name}</span>
          <span className="block truncate text-xs leading-tight text-ink-3">{away ? 'Working as super admin' : 'HRMS'}</span>
        </span>
        <ChevronsUpDown size={14} strokeWidth={1.5} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <div className="pop absolute left-0 right-0 top-11 z-50 rounded-xl border border-line bg-surface py-1 shadow-float" role="listbox">
          <p className="px-3 pb-1 pt-2 text-xs text-ink-3">Switch company</p>
          <ul className="max-h-72 overflow-y-auto">
            {companies.map((c) => {
              const current = c.id === user.companyId;
              return (
                <li key={c.id}>
                  <button
                    role="option"
                    aria-selected={current}
                    disabled={current || switching !== null}
                    onClick={async () => {
                      setSwitching(c.id);
                      try {
                        await switchCompany(c.id);
                      } catch (e) {
                        setSwitching(null);
                        toast(e instanceof Error ? e.message : 'Could not switch company', 'bad');
                      }
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${current ? 'text-ink' : 'text-ink-2 hover:bg-bg hover:text-ink'}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    {c.status === 'disabled' && <span className="text-xs text-ink-3">Disabled</span>}
                    {c.id === user.homeCompanyId && !current && <span className="text-xs text-ink-3">Home</span>}
                    {switching === c.id ? (
                      <Loader2 size={14} strokeWidth={1.5} className="animate-spin text-ink-3" />
                    ) : (
                      current && <Check size={14} strokeWidth={1.5} className="text-brand" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 border-t border-line pt-1">
            <Link to="/admin/companies" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm text-ink-2 transition-colors hover:bg-bg hover:text-ink">
              <Building {...ICON} className="text-ink-3" /> Manage companies
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, can } = useAuth();
  const counts = useQuery({
    queryKey: ['nav-counts'],
    queryFn: () => api<NavCounts>('/dashboard/counts'),
    refetchInterval: 60_000,
    enabled: !!user,
  });

  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => (i.superAdmin ? !!user?.isSuperAdmin : i.self ? !!user?.sipId : !i.perms || can(...i.perms))),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-ink/20 lg:hidden" onClick={onClose} />}
      <aside
        className={`print:hidden fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-line bg-surface transition-transform duration-200 ease-out lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 items-center gap-1 px-3">
          <CompanySwitcher />
          <button className="icon-btn ml-auto shrink-0 lg:hidden" onClick={onClose} aria-label="Close menu">
            <X {...ICON} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {groups.map((section, i) => (
            <div key={section.group || i} className={section.group ? 'mt-6' : 'mt-2'}>
              {section.group && <p className="mb-2 px-2 text-xs text-ink-3">{section.group}</p>}
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const n = item.count ? counts.data?.[item.count] : undefined;
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.to === '/'}
                        onClick={onClose}
                        className={({ isActive }) =>
                          `flex h-8 items-center gap-2.5 rounded-lg px-2 text-sm transition-colors duration-150 ${
                            isActive
                              ? 'bg-raised font-medium text-ink shadow-[inset_0_0_0_1px_rgba(23,23,23,0.06)]'
                              : 'text-ink-2 hover:bg-raised/60 hover:text-ink'
                          }`
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <span className={`grid w-4 place-items-center ${isActive ? 'text-brand' : 'text-ink-3'}`}>{item.icon}</span>
                            <span className="flex-1 truncate">{item.label}</span>
                            {!!n && <span className="num text-xs text-ink-3">{n}</span>}
                          </>
                        )}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}

type Notification = { id: number; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string };

function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ data: Notification[]; unread: number }>('/notifications'),
    refetchInterval: 60_000,
  });
  const markRead = useMutation({
    mutationFn: (id?: number) => api('/notifications/read', { method: 'POST', body: id ? { id } : {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button className="icon-btn relative" onClick={() => setOpen((o) => !o)} aria-label={`Notifications, ${unread} unread`}>
        <Bell {...ICON} />
        {unread > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand ring-2 ring-bg" />}
      </button>
      {open && (
        <div className="pop absolute right-0 top-10 z-30 w-80 rounded-xl border border-line bg-surface shadow-float">
          <div className="flex items-center justify-between px-4 py-3">
            <p className="text-sm font-medium">Notifications</p>
            {unread > 0 && (
              <button className="text-xs text-ink-3 transition-colors hover:text-ink" onClick={() => markRead.mutate(undefined)}>
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto border-t border-line">
            {(q.data?.data ?? []).length === 0 && <li className="px-4 py-8 text-center text-sm text-ink-3">Nothing new</li>}
            {(q.data?.data ?? []).map((n) => (
              <li key={n.id}>
                <button
                  className="flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-bg"
                  onClick={() => {
                    if (!n.readAt) markRead.mutate(n.id);
                    setOpen(false);
                    if (n.link) navigate(n.link);
                  }}
                >
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-brand'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{n.title}</span>
                    {n.body && <span className="mt-0.5 block text-xs text-ink-3">{n.body}</span>}
                  </span>
                  <span className="num shrink-0 text-xs text-ink-3">{relative(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!user) return null;
  return (
    <div className="relative" ref={ref}>
      <button className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-raised" onClick={() => setOpen((o) => !o)}>
        <Avatar name={user.name} size={24} />
        <span className="hidden text-sm sm:inline">{user.name}</span>
      </button>
      {open && (
        <div className="pop absolute right-0 top-10 z-30 w-60 rounded-xl border border-line bg-surface py-1 shadow-float">
          <div className="px-4 py-3">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-ink-3">{user.email}</p>
            <p className="mt-1 text-xs text-ink-3">{user.roleLabel}</p>
          </div>
          <div className="border-t border-line py-1">
            <button
              className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-ink-2 transition-colors hover:bg-bg hover:text-ink"
              onClick={() => {
                setOpen(false);
                setPwOpen(true);
              }}
            >
              <KeyRound {...ICON} className="text-ink-3" /> Change password
            </button>
            <button
              className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-ink-2 transition-colors hover:bg-bg hover:text-ink"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              <LogOut {...ICON} className="text-ink-3" /> Sign out
            </button>
          </div>
        </div>
      )}
      <ChangePassword open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

function ChangePassword({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const m = useMutation({
    mutationFn: () => api('/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: next } }),
    onSuccess: async () => {
      toast('Password changed. Sign in again');
      await logout();
      navigate('/login');
    },
  });
  return (
    <Modal
      open={open}
      title="Change password"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!current || next.length < 8 || m.isPending} onClick={() => m.mutate()}>
            Change password
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={m.error?.message} />
        <Field label="Current password">
          <input type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="New password" hint="At least 8 characters. You will be signed out everywhere">
          <input type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
    </Modal>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const canSearch = can('employees.view', 'team.view');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="print:hidden sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur sm:px-6 lg:px-8">
      <button className="icon-btn lg:hidden" onClick={onMenu} aria-label="Open menu">
        <Menu {...ICON} />
      </button>
      {canSearch && (
        <form
          className="relative w-full max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) navigate(`/employees?search=${encodeURIComponent(q.trim())}`);
          }}
        >
          <Search size={16} strokeWidth={1.5} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            ref={inputRef}
            className="input pl-9 pr-10"
            placeholder="Search by name, SIP ID or CNIC"
            aria-label="Search employees"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd className="num pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-raised px-1.5 text-xs text-ink-3 sm:block">
            /
          </kbd>
        </form>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Notifications />
        <UserMenu />
      </div>
    </header>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  return (
    <div className="flex min-h-screen">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="min-w-0 flex-1">
        <TopBar onMenu={() => setMenuOpen(true)} />
        <main key={location.pathname} className="rise mx-auto w-full max-w-[1440px] px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
      <Toaster />
    </div>
  );
}
