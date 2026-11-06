import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileDown } from 'lucide-react';
import { payrollApi } from '../../api/payroll';
import { EmptyState, ErrorState, ICON, Loading, PageHeader, StatusTag } from '../../components/ui';
import { date, days, money, month } from '../../lib/format';

export function MyPayslips() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['payroll', 'me', 'payslips'], queryFn: payrollApi.myPayslips });

  return (
    <div>
      <PageHeader eyebrow="My space" title="My payslips" subtitle="Payslips appear here once a month's payroll is approved" />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : q.data!.data.length === 0 ? (
        <EmptyState title="No payslips yet" hint="Your payslip shows up here after payroll for the month is approved" illustration="payroll.empty" />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Month</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Unpaid days</th>
                  <th className="th text-right">Gross earned</th>
                  <th className="th text-right">Additions</th>
                  <th className="th text-right">Deductions</th>
                  <th className="th text-right">Net, PKR</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {q.data!.data.map((p) => (
                  <tr key={p.id} className="row-link" onClick={() => navigate(`/payroll/payslips/${p.id}`)}>
                    <td className="td font-medium">{month(p.periodMonth)}</td>
                    <td className="td">
                      <StatusTag value={p.runStatus} text={p.runStatus === 'paid' && p.paidAt ? `Paid ${date(p.paidAt.slice(0, 10), true)}` : undefined} />
                    </td>
                    <td className="td num text-right text-ink-2">{days(p.unpaidDays)}</td>
                    <td className="td num text-right">{money(p.grossA)}</td>
                    <td className="td num text-right text-ink-2">{money(p.totalAdditionsB)}</td>
                    <td className="td num text-right text-ink-2">{money(p.totalDeductionsC)}</td>
                    <td className="td num text-right font-medium">{money(p.netTotal)}</td>
                    <td className="td text-right" onClick={(e) => e.stopPropagation()}>
                      <a href={payrollApi.payslipPdfUrl(p.id)} className="icon-btn ml-auto" aria-label={`Download the ${month(p.periodMonth)} payslip as PDF`} title="Download PDF">
                        <FileDown {...ICON} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
