/**
 * Route map. Each module owns the pages under pages/<module>/ and exports the
 * component names imported here.
 */
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { EmptyState, Loading } from './components/ui';
import { useAuth, type Permission } from './lib/auth';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Users } from './pages/admin/Users';
import { AuditTrail } from './pages/admin/AuditTrail';
import { Companies } from './pages/admin/Companies';
import { Integrations } from './pages/admin/Integrations';
// Recruitment
import { Pipeline } from './pages/recruitment/Pipeline';
import { Candidates } from './pages/recruitment/Candidates';
import { CandidateProfile } from './pages/recruitment/CandidateProfile';
import { Interviews } from './pages/recruitment/Interviews';
// People
import { Employees } from './pages/employees/Employees';
import { EmployeeForm } from './pages/employees/EmployeeForm';
import { EmployeeProfile } from './pages/employees/EmployeeProfile';
import { Departments } from './pages/employees/Departments';
import { Documents } from './pages/employees/Documents';
import { MyProfile } from './pages/employees/MyProfile';
// Payroll
import { PayrollRuns } from './pages/payroll/PayrollRuns';
import { PayrollRunDetail } from './pages/payroll/PayrollRunDetail';
import { PayslipView } from './pages/payroll/PayslipView';
import { SalaryStructures } from './pages/payroll/SalaryStructures';
import { LoansAdvances } from './pages/payroll/LoansAdvances';
import { PayrollSettings } from './pages/payroll/PayrollSettings';
import { MyPayslips } from './pages/payroll/MyPayslips';
// Leave
import { LeaveRequests } from './pages/leave/LeaveRequests';
import { LeaveApply } from './pages/leave/LeaveApply';
import { LeaveBalances } from './pages/leave/LeaveBalances';
import { LeaveTypes } from './pages/leave/LeaveTypes';
import { MyLeave } from './pages/leave/MyLeave';

/** Shows the page only to users holding one of `perms`; `self` = needs a linked employee record. */
function Guard({ perms, self, children }: { perms?: Permission[]; self?: boolean; children: ReactNode }) {
  const { user, can } = useAuth();
  const allowed = self ? !!user?.sipId : !perms || can(...perms);
  if (!allowed) {
    return <EmptyState title="You don't have access to this page" hint="Ask an HR admin if you need it" />;
  }
  return <>{children}</>;
}

/** Signed-out users go to /login; people without the dashboard land on their own space. */
function Home() {
  const { user, can } = useAuth();
  if (can('dashboard.view')) return <Dashboard />;
  if (user?.sipId) return <Navigate to="/me/profile" replace />;
  return <EmptyState title="Nothing to show yet" hint="Your account has no pages assigned. Ask an HR admin" />;
}

export function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loading inline />
      </div>
    );
  }
  if (location.pathname === '/login') return <Login />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;

  const P = (perms: Permission[], el: ReactNode) => <Guard perms={perms}>{el}</Guard>;
  const S = (el: ReactNode) => <Guard self>{el}</Guard>;
  const recruit: Permission[] = ['recruitment.view'];
  const people: Permission[] = ['employees.view', 'team.view'];
  const payroll: Permission[] = ['payroll.view'];

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />

        <Route path="/me/profile" element={S(<MyProfile />)} />
        <Route path="/me/leave" element={S(<MyLeave />)} />
        <Route path="/me/payslips" element={S(<MyPayslips />)} />

        <Route path="/recruitment/pipeline" element={P(recruit, <Pipeline />)} />
        <Route path="/recruitment/candidates" element={P(recruit, <Candidates />)} />
        <Route path="/recruitment/candidates/:id" element={P(recruit, <CandidateProfile />)} />
        <Route path="/recruitment/interviews" element={P(recruit, <Interviews />)} />

        <Route path="/employees" element={P(people, <Employees />)} />
        <Route path="/employees/new" element={P(['employees.manage'], <EmployeeForm />)} />
        <Route path="/employees/:sipId" element={P(people, <EmployeeProfile />)} />
        <Route path="/employees/:sipId/edit" element={P(['employees.manage'], <EmployeeForm />)} />
        <Route path="/departments" element={P(['employees.manage'], <Departments />)} />
        <Route path="/documents" element={P(['employees.view', 'documents.manage'], <Documents />)} />

        <Route path="/payroll/runs" element={P(payroll, <PayrollRuns />)} />
        <Route path="/payroll/runs/:id" element={P(payroll, <PayrollRunDetail />)} />
        {/* payslip view checks access itself: payroll.view, or the employee's own payslip */}
        <Route path="/payroll/payslips/:id" element={<PayslipView />} />
        <Route path="/payroll/structures" element={P(payroll, <SalaryStructures />)} />
        <Route path="/payroll/loans" element={P(payroll, <LoansAdvances />)} />
        <Route path="/payroll/settings" element={P(['payroll.manage', 'settings.manage'], <PayrollSettings />)} />

        <Route path="/leave/requests" element={P(['leave.view', 'leave.approve', 'leave.approve.team'], <LeaveRequests />)} />
        <Route path="/leave/apply" element={<LeaveApply />} />
        <Route path="/leave/balances" element={P(['leave.view', 'leave.manage', 'leave.approve.team'], <LeaveBalances />)} />
        <Route path="/leave/types" element={P(['leave.manage'], <LeaveTypes />)} />

        <Route path="/admin/users" element={P(['users.manage'], <Users />)} />
        <Route path="/admin/audit" element={P(['audit.view'], <AuditTrail />)} />
        {/* the page itself checks for a super admin; the server refuses everyone else */}
        <Route path="/admin/companies" element={<Companies />} />
        <Route path="/admin/integrations" element={P(['integrations.manage'], <Integrations />)} />

        <Route path="*" element={<EmptyState title="Page not found" hint="Check the address or pick a page from the menu" />} />
      </Routes>
    </Layout>
  );
}
