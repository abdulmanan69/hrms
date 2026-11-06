import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, Pencil, Upload } from 'lucide-react';
import {
  Avatar,
  Card,
  CardHead,
  ConfirmModal,
  DetailList,
  ErrorState,
  FormError,
  ICON,
  Loading,
  SipId,
  StatusTag,
  Tabs,
  toast,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { date, dateTime, label } from '../../lib/format';
import { empKeys, employeesApi, type DocumentType, type EmployeeDetail } from '../../api/employees';
import { EmployeeSalaryPanel } from '../payroll/EmployeeSalaryPanel';
import { EmployeeLeavePanel } from '../leave/EmployeeLeavePanel';
import { ConnectedAccounts } from './ConnectedAccounts';
import { SalesPanel } from '../sales/SalesPanel';
import { DocumentList, HistoryTimeline, QuickUploadButton, ReasonModal, UploadDocumentModal, useInvalidateEmployees } from './parts';
import { statusText } from './Employees';

type Tab = 'details' | 'documents' | 'salary' | 'leave' | 'sales' | 'history';

/** Blocker text from the server mapped to the document that fixes it. */
const BLOCKER_DOC: Record<string, DocumentType> = { 'CNIC copy': 'cnic', 'signed contract': 'contract' };

export function EmployeeProfile() {
  const { sipId = '' } = useParams<{ sipId: string }>();
  const q = useQuery({ queryKey: empKeys.detail(sipId), queryFn: () => employeesApi.get(sipId) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState message={q.error?.message ?? 'Employee not found'} onRetry={() => q.refetch()} />;
  return <Profile emp={q.data} />;
}

function Profile({ emp }: { emp: EmployeeDetail }) {
  const { user, can } = useAuth();
  const invalidate = useInvalidateEmployees();
  const manage = can('employees.manage');
  const docsManage = can('documents.manage', 'employees.manage');
  const own = user?.sipId === emp.sipId;
  const showSalary = can('payroll.view') || own;
  const showSales = can('sales.view') || can('team.view') || own;
  const [tab, setTab] = useState<Tab>('details');
  const [deactivating, setDeactivating] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [uploading, setUploading] = useState(false);

  const activate = useMutation({
    mutationFn: () => employeesApi.activate(emp.sipId),
    onSuccess: () => {
      invalidate();
      toast(`${emp.name} is now active`);
    },
    onError: (e) => toast(e.message, 'bad'),
  });
  const deactivate = useMutation({
    mutationFn: (reason: string) => employeesApi.deactivate(emp.sipId, reason),
    onSuccess: () => {
      invalidate();
      setDeactivating(false);
      toast(`${emp.name} deactivated`);
    },
  });
  const reactivate = useMutation({
    mutationFn: () => employeesApi.reactivate(emp.sipId),
    onSuccess: (res) => {
      invalidate();
      setReactivating(false);
      toast(res.status === 'active' ? `${emp.name} is active again` : `${emp.name} reactivated as pending: documents missing`);
    },
  });

  const blocked = emp.blockers.length > 0;
  const tabs: Array<{ value: Tab; label: string; count?: number }> = [
    { value: 'details', label: 'Details' },
    { value: 'documents', label: 'Documents', count: emp.documents.length },
    ...(showSalary ? [{ value: 'salary' as Tab, label: 'Salary' }] : []),
    { value: 'leave', label: 'Leave' },
    ...(showSales ? [{ value: 'sales' as Tab, label: 'Sales' }] : []),
    { value: 'history', label: 'History' },
  ];

  return (
    <div className="rise">
      <div className="mb-8">
        <Link to="/employees" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-3 transition-colors hover:text-ink">
          <ArrowLeft size={14} strokeWidth={1.5} /> Employees
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <Avatar name={emp.name} size={56} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[28px] font-medium leading-tight tracking-[-0.01em]">{emp.name}</h1>
                <SipId id={emp.sipId} />
                <StatusTag value={emp.status} text={statusText(emp.status)} />
              </div>
              <p className="mt-1 text-sm text-ink-2">
                {[emp.designationTitle, emp.departmentName].filter(Boolean).join(' · ') || 'No designation or department yet'}
              </p>
            </div>
          </div>
          {manage && (
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/employees/${emp.sipId}/edit`} className="btn-secondary">
                <Pencil {...ICON} className="text-ink-3" />
                Edit
              </Link>
              {emp.status === 'pending' && (
                <button
                  className="btn-primary"
                  disabled={blocked || activate.isPending}
                  title={blocked ? `Missing: ${emp.blockers.join(', ')}` : undefined}
                  onClick={() => activate.mutate()}
                >
                  <Check {...ICON} />
                  Activate
                </button>
              )}
              {emp.status === 'inactive' ? (
                <button className="btn-secondary" onClick={() => setReactivating(true)}>
                  Reactivate
                </button>
              ) : (
                <button className="btn-secondary" onClick={() => setDeactivating(true)}>
                  Deactivate
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {emp.status === 'pending' && (
        <div className="card mb-6 flex flex-wrap items-start gap-4 border-warn/30 bg-warn-soft/40 px-5 py-4">
          <AlertTriangle {...ICON} className="mt-0.5 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            {blocked ? (
              <>
                <p className="text-sm font-medium">Can't go active yet</p>
                <p className="mt-0.5 text-sm text-ink-2">
                  Missing {emp.blockers.join(', ')}. Pending employees are left out of payroll until these are on file.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Ready to activate</p>
                <p className="mt-0.5 text-sm text-ink-2">CNIC number, CNIC copy and signed contract are on file.</p>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {docsManage &&
              emp.blockers
                .filter((b) => BLOCKER_DOC[b])
                .map((b) => (
                  <QuickUploadButton key={b} sipId={emp.sipId} type={BLOCKER_DOC[b]}>
                    Upload {b}
                  </QuickUploadButton>
                ))}
            {manage && emp.blockers.includes('CNIC number') && (
              <Link to={`/employees/${emp.sipId}/edit`} className="btn-secondary btn-sm">
                Add CNIC number
              </Link>
            )}
          </div>
        </div>
      )}

      {emp.status === 'inactive' && (
        <div className="card mb-6 px-5 py-4 text-sm text-ink-2">
          Inactive since {dateTime(emp.deactivatedAt)}. The record is kept for payroll and leave history; see History for the reason.
        </div>
      )}

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'details' && <Details emp={emp} />}

      {tab === 'documents' && (
        <Card>
          <CardHead
            title="Documents"
            meta="CNIC copy and signed contract are required before the record can go active"
            actions={
              docsManage && (
                <button className="btn-secondary btn-sm" onClick={() => setUploading(true)}>
                  <Upload {...ICON} className="text-ink-3" />
                  Upload
                </button>
              )
            }
          />
          <DocumentList
            sipId={emp.sipId}
            documents={emp.documents}
            required={emp.requiredDocuments}
            canManage={docsManage}
            employeeActive={emp.status === 'active'}
          />
        </Card>
      )}

      {tab === 'salary' && showSalary && (
        <Card className="p-5">
          <EmployeeSalaryPanel sipId={emp.sipId} />
        </Card>
      )}

      {tab === 'leave' && (
        <Card className="p-5">
          <EmployeeLeavePanel sipId={emp.sipId} />
        </Card>
      )}

      {tab === 'sales' && showSales && (
        <Card className="p-5">
          <SalesPanel sipId={emp.sipId} />
        </Card>
      )}

      {tab === 'history' && <HistoryTimeline sipId={emp.sipId} />}

      <UploadDocumentModal
        open={uploading}
        onClose={() => setUploading(false)}
        sipId={emp.sipId}
        employeeName={emp.name}
        defaultType={(emp.blockers.map((b) => BLOCKER_DOC[b]).find(Boolean) as DocumentType | undefined) ?? 'other'}
      />

      <ReasonModal
        open={deactivating}
        title={`Deactivate ${emp.name}`}
        body={
          <>
            {emp.name} leaves payroll and leave from today. Nothing is deleted and the record can be reactivated.
            {emp.directReports.filter((r) => r.status === 'active').length > 0 &&
              ` ${emp.directReports.filter((r) => r.status === 'active').length} people report to them; pick a new manager for them afterwards.`}
          </>
        }
        confirmLabel="Deactivate"
        busy={deactivate.isPending}
        error={deactivate.error?.message}
        onClose={() => {
          setDeactivating(false);
          deactivate.reset();
        }}
        onConfirm={(reason) => deactivate.mutate(reason)}
      />

      <ConfirmModal
        open={reactivating}
        title={`Reactivate ${emp.name}`}
        body={
          emp.blockers.length > 0
            ? `Required items are missing (${emp.blockers.join(', ')}), so the record returns as pending activation.`
            : 'The record returns to active and is included in the next payroll run.'
        }
        confirmLabel="Reactivate"
        busy={reactivate.isPending}
        onClose={() => {
          setReactivating(false);
          reactivate.reset();
        }}
        onConfirm={() => reactivate.mutate()}
      >
        <div className="mt-3">
          <FormError message={reactivate.error?.message} />
        </div>
      </ConfirmModal>
    </div>
  );
}

function Details({ emp }: { emp: EmployeeDetail }) {
  const address = [emp.address1, emp.address2, emp.city, emp.state, emp.postalCode, emp.country].filter(Boolean).join(', ');
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <Card>
          <CardHead title="Identity" />
          <div className="px-5 pb-5">
            <DetailList
              items={[
                { label: 'First name', value: emp.firstName },
                { label: 'Middle initial', value: emp.middleInitial },
                { label: 'Last name', value: emp.lastName },
                { label: 'Gender', value: emp.gender ? label(emp.gender) : null },
                ...(emp.sensitiveVisible
                  ? [
                      { label: 'CNIC', value: emp.cnic, mono: true },
                      { label: 'Date of birth', value: emp.dateOfBirth ? date(emp.dateOfBirth) : null },
                    ]
                  : []),
              ]}
              cols={3}
            />
          </div>
        </Card>
        <Card>
          <CardHead title="Contact and address" />
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
          <CardHead title="Employment" />
          <div className="px-5 pb-5">
            <DetailList
              cols={3}
              items={[
                { label: 'Department', value: emp.departmentName },
                { label: 'Designation', value: emp.designationTitle },
                {
                  label: 'Manager',
                  value: emp.managerSipId ? (
                    <span className="inline-flex items-center gap-2">
                      {emp.managerName} <SipId id={emp.managerSipId} to={`/employees/${emp.managerSipId}`} />
                    </span>
                  ) : null,
                },
                { label: 'Employment status', value: <StatusTag value={emp.employmentStatus} /> },
                { label: 'Joining date', value: date(emp.dateOfJoining) },
                { label: 'Status', value: <StatusTag value={emp.status} text={statusText(emp.status)} /> },
              ]}
            />
          </div>
        </Card>
        {emp.sensitiveVisible && (
          <Card>
            <CardHead title="Bank" meta="Where salary is paid" />
            <div className="px-5 pb-5">
              <DetailList
                items={[
                  { label: 'Bank', value: emp.bankName },
                  { label: 'Account number', value: emp.accountNo, mono: true },
                ]}
              />
            </div>
          </Card>
        )}
        {emp.remarks && (
          <Card>
            <CardHead title="Remarks" />
            <p className="whitespace-pre-line px-5 pb-5 text-sm text-ink-2">{emp.remarks}</p>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        <Card>
          <CardHead title="Record" />
          <div className="px-5 pb-5">
            <DetailList
              cols={2}
              items={[
                { label: 'SIP ID', value: <SipId id={emp.sipId} /> },
                { label: 'Added', value: date(emp.createdAt.slice(0, 10)) },
                {
                  label: 'Came from',
                  value: emp.sourceCandidateId ? (
                    <Link className="transition-colors hover:text-brand" to={`/recruitment/candidates/${emp.sourceCandidateId}`}>
                      Candidate #{emp.sourceCandidateId}
                    </Link>
                  ) : (
                    'Added directly'
                  ),
                },
                { label: 'Sign-in account', value: emp.linkedUser ? emp.linkedUser.email : 'None' },
              ]}
            />
          </div>
        </Card>
        <Card>
          <CardHead title="Direct reports" meta={emp.directReports.length ? undefined : 'Nobody reports to this person'} />
          {emp.directReports.length > 0 && (
            <ul className="divide-y divide-line border-t border-line">
              {emp.directReports.map((r) => (
                <li key={r.sipId} className="flex items-center gap-2 px-5 py-3">
                  <Link to={`/employees/${r.sipId}`} className="truncate text-sm transition-colors hover:text-brand">
                    {r.name}
                  </Link>
                  <SipId id={r.sipId} />
                  <span className="ml-auto">
                    <StatusTag value={r.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <ConnectedAccounts sipId={emp.sipId} />
      </div>
    </div>
  );
}
