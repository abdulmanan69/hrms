import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { payrollApi } from '../../api/payroll';
import { ApiError } from '../../lib/api';
import { DetailList, EmptyState, ErrorState, ICON, Loading, StatusTag, Tag } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { date, money, month } from '../../lib/format';
import { Flags, StructureModal } from './shared';

/** Salary tab on the employee profile. Owned by the payroll module. */
export function EmployeeSalaryPanel({ sipId }: { sipId: string }) {
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const allowed = can('payroll.view') || user?.sipId === sipId;
  const q = useQuery({ queryKey: ['payroll', 'panel', sipId], queryFn: () => payrollApi.salaryPanel(sipId), enabled: allowed });

  if (!allowed || (q.error instanceof ApiError && q.error.status === 403)) {
    return <EmptyState bare title="Salary is private" hint="Only payroll staff and the employee can see salary details" />;
  }
  if (q.isLoading) return <Loading inline />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const { current, history, loan, payslips } = q.data!;
  const latest = history[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="card xl:col-span-2">
          <div className="card-head">
            <div>
              <p className="card-title">Current salary</p>
              {current && <p className="text-xs text-ink-3">Since {date(current.effectiveFrom)}</p>}
            </div>
            {can('payroll.manage') && (
              <button className="btn-secondary btn-sm" onClick={() => setAdding(true)}>
                <Plus {...ICON} className="text-ink-3" /> {latest ? 'Add increment' : 'Add salary'}
              </button>
            )}
          </div>
          <div className="px-5 pb-5">
            {current ? (
              <>
                <DetailList
                  cols={3}
                  items={[
                    { label: 'Basic', value: money(current.basicSalary), mono: true },
                    { label: 'House rent', value: money(current.houseRent), mono: true },
                    { label: 'Medical', value: money(current.medicalAllowance), mono: true },
                    { label: 'Petrol', value: money(current.petrolAllowance), mono: true },
                    { label: 'Other allowance', value: money(current.otherAllowance), mono: true },
                    { label: 'Deductions', value: <Flags s={current} /> },
                  ]}
                />
                <div className="mt-5 flex items-baseline justify-between border-y-[3px] border-double border-ink/15 py-3">
                  <span className="text-sm font-medium">Gross a month, PKR</span>
                  <span className="num text-base font-medium text-brand">{money(current.grossSalary)}</span>
                </div>
              </>
            ) : (
              <EmptyState bare title="No salary structure" hint="Add a salary from the joining date so this person is included in payroll" />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <p className="card-title">Loan and advance</p>
          </div>
          <div className="px-5 pb-5">
            <p className={`num text-[28px] font-medium leading-none ${loan.balance > 0 ? '' : 'text-ink-3'}`}>{money(loan.balance)}</p>
            <p className="mt-3 text-xs text-ink-3">
              {loan.balance > 0 ? `Outstanding, ${money(Math.min(loan.installment, loan.balance))} deducted a month` : 'Nothing outstanding'}
            </p>
            {can('payroll.view') && (
              <Link to="/payroll/loans" className="btn-secondary btn-sm mt-4">
                Loans and advances
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="card-head">
          <p className="card-title">Salary history</p>
        </div>
        {history.length === 0 ? (
          <EmptyState bare title="No history" hint="Each salary change adds a row from its effective date" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">From</th>
                  <th className="th text-right">Basic</th>
                  <th className="th text-right">Allowances</th>
                  <th className="th text-right">Gross, PKR</th>
                  <th className="th">Note</th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => (
                  <tr key={s.id}>
                    <td className="td">
                      <span className="flex items-center gap-2">
                        {date(s.effectiveFrom)}
                        {s.isCurrent && <Tag tone="good">Current</Tag>}
                        {s.isFuture && <Tag tone="brand">Planned</Tag>}
                      </span>
                    </td>
                    <td className="td num text-right">{money(s.basicSalary)}</td>
                    <td className="td num text-right text-ink-2">{money(s.grossSalary - s.basicSalary)}</td>
                    <td className="td num text-right font-medium">{money(s.grossSalary)}</td>
                    <td className="td text-ink-2">{s.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="card-head">
          <p className="card-title">Recent payslips</p>
        </div>
        {payslips.length === 0 ? (
          <EmptyState bare title="No payslips yet" hint="Payslips appear after this person is included in a payroll run" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Month</th>
                  <th className="th">Status</th>
                  <th className="th text-right">A</th>
                  <th className="th text-right">B</th>
                  <th className="th text-right">C</th>
                  <th className="th text-right">Net, PKR</th>
                </tr>
              </thead>
              <tbody>
                {payslips.map((p) => (
                  <tr key={p.id} className="row-link" onClick={() => navigate(`/payroll/payslips/${p.id}`)}>
                    <td className="td font-medium">{month(p.periodMonth)}</td>
                    <td className="td">
                      <StatusTag value={p.runStatus} />
                    </td>
                    <td className="td num text-right">{money(p.grossA)}</td>
                    <td className="td num text-right text-ink-2">{money(p.totalAdditionsB)}</td>
                    <td className="td num text-right text-ink-2">{money(p.totalDeductionsC)}</td>
                    <td className="td num text-right font-medium">{money(p.netTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <StructureModal open={adding} onClose={() => setAdding(false)} employee={{ sipId, name: sipId }} current={latest} />
    </div>
  );
}
