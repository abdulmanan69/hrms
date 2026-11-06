import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setPageCompany } from './api';

const SWITCH_KEY = 'hrms-company-switch';

export interface AuthUser {
  userId: number;
  email: string;
  name: string;
  /** the company this session works in; everything shown belongs to it */
  companyId: number;
  companyName: string;
  companySlug: string;
  homeCompanyId: number;
  isSuperAdmin: boolean;
  roleName: string;
  roleLabel: string;
  permissions: string[];
  /** linked employee record; null when the account is not staff */
  sipId: string | null;
}

/** Mirrors server/src/auth/permissions.ts */
export type Permission =
  | 'dashboard.view'
  | 'recruitment.view'
  | 'recruitment.manage'
  | 'employees.view'
  | 'team.view'
  | 'employees.manage'
  | 'employees.sensitive'
  | 'documents.manage'
  | 'payroll.view'
  | 'payroll.manage'
  | 'payroll.approve'
  | 'leave.view'
  | 'leave.approve'
  | 'leave.approve.team'
  | 'leave.manage'
  | 'users.manage'
  | 'audit.view'
  | 'settings.manage'
  | 'integrations.manage'
  | 'metrics.write'
  | 'sales.view'
  | 'sales.manage'
  | 'sales.write'
  | 'attendance.view'
  | 'attendance.manage'
  | 'attendance.write';

export interface CompanyOption {
  id: number;
  name: string;
  slug: string;
  status: 'active' | 'disabled';
}

/** Sign-in found the same email and password in several companies. */
export class ChooseCompanyError extends Error {
  constructor(public companies: Array<{ slug: string; name: string }>) {
    super('Pick the company to sign in to');
  }
}

interface AuthState {
  user: AuthUser | null;
  company: { id: number; name: string; slug: string; currency: string } | null;
  /** companies the user may switch to (all of them for a super admin) */
  companies: CompanyOption[];
  loading: boolean;
  login: (email: string, password: string, company?: string) => Promise<void>;
  switchCompany: (companyId: number) => Promise<void>;
  logout: () => Promise<void>;
  /** true when the user holds any of the given permissions */
  can: (...perms: Permission[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [company, setCompany] = useState<AuthState['company']>(null);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      const me = await api<{ user: AuthUser; company: NonNullable<AuthState['company']>; companies: CompanyOption[] }>('/auth/me');
      setPageCompany(me.user.companyId);
      setUser(me.user);
      setCompany(me.company);
      setCompanies(me.companies);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMe();
    const onUnauthorized = () => {
      setUser(null);
      qc.clear();
    };
    window.addEventListener('hrms:unauthorized', onUnauthorized);
    // another tab switched company: reload so this tab never shows the old one's data
    const onStorage = (e: StorageEvent) => {
      if (e.key === SWITCH_KEY) window.location.assign('/');
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('hrms:unauthorized', onUnauthorized);
      window.removeEventListener('storage', onStorage);
    };
  }, [loadMe, qc]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      company,
      companies,
      loading,
      login: async (email, password, companySlug) => {
        try {
          await api('/auth/login', { method: 'POST', body: { email, password, company: companySlug } });
        } catch (err) {
          if (err instanceof ApiError && err.code === 'choose_company') throw new ChooseCompanyError(err.companies ?? []);
          throw err;
        }
        qc.clear();
        await loadMe();
      },
      switchCompany: async (companyId) => {
        await api('/auth/company', { method: 'POST', body: { companyId } });
        try {
          // other open tabs reload into the new company too
          localStorage.setItem(SWITCH_KEY, `${companyId}:${Date.now()}`);
        } catch {
          // storage unavailable: other tabs catch up on their next request
        }
        // a fresh start: nothing from the previous company stays in memory or on screen
        qc.clear();
        window.location.assign('/');
      },
      logout: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        qc.clear();
        setUser(null);
      },
      can: (...perms) => !!user && (user.permissions.includes('*') || perms.some((p) => user.permissions.includes(p))),
    }),
    [user, company, companies, loading, loadMe, qc],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
