/**
 * Flat permission catalogue. Roles carry arrays of these strings; '*' grants
 * everything. Checks always happen server-side; the UI only hides what the
 * server would refuse anyway.
 *
 * Self-service (own profile, own payslips, own leave) needs no permission:
 * any signed-in user whose account is linked to an employee (users.sip_id)
 * can reach the /me endpoints for that one record.
 */
export const PERMISSIONS = [
  'dashboard.view',
  'recruitment.view',
  'recruitment.manage',
  /** every employee record */
  'employees.view',
  /** only the people who report to the signed-in manager */
  'team.view',
  'employees.manage',
  /** CNIC, bank account, date of birth */
  'employees.sensitive',
  'documents.manage',
  'payroll.view',
  'payroll.manage',
  'payroll.approve',
  'leave.view',
  /** approve or reject anyone's leave */
  'leave.approve',
  /** approve or reject the leave of one's own reports */
  'leave.approve.team',
  /** leave types, balance adjustments, accrual runs */
  'leave.manage',
  'users.manage',
  'audit.view',
  'settings.manage',
  /** API keys, webhooks and the event stream for other systems */
  'integrations.manage',
  /** other systems (e.g. VICIdial) report figures per employee: QA scores, hours */
  'metrics.write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PRESETS: Record<string, { label: string; description: string; permissions: string[] }> = {
  admin: {
    label: 'HR admin',
    description: 'Full access to every module, users and settings',
    permissions: ['*'],
  },
  recruiter: {
    label: 'Recruiter',
    description: 'Runs the hiring pipeline; reads the staff register',
    permissions: ['dashboard.view', 'recruitment.view', 'recruitment.manage', 'employees.view'],
  },
  finance: {
    label: 'Payroll and finance',
    description: 'Runs and approves payroll; reads staff and leave',
    permissions: [
      'dashboard.view',
      'employees.view',
      'employees.sensitive',
      'payroll.view',
      'payroll.manage',
      'payroll.approve',
      'leave.view',
    ],
  },
  manager: {
    label: 'Manager',
    description: 'Sees their own team and approves its leave',
    permissions: ['dashboard.view', 'team.view', 'leave.approve.team'],
  },
  employee: {
    label: 'Employee',
    description: 'Self-service: own profile, payslips and leave',
    permissions: [],
  },
};

export function hasPermission(granted: string[], needed: Permission): boolean {
  return granted.includes('*') || granted.includes(needed);
}
