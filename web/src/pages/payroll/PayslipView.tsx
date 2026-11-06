import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileDown, Printer } from 'lucide-react';
import { payrollApi, type Payslip } from '../../api/payroll';
import { ErrorState, ICON, Loading, PageHeader, StatusTag } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { date, days, label, money, month } from '../../lib/format';

/** Hides the app chrome (sidebar, top bar) and page padding when printing. */
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm; }
  aside, header { display: none !important; }
  main { padding: 0 !important; max-width: none !important; animation: none !important; }
  body { background: #fff !important; }
}`;

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? '-' + ONES[r % 10] : ''}`;
  return [h ? `${ONES[h]} hundred` : '', rest].filter(Boolean).join(' ');
}

/** 56591 → "Fifty-six thousand five hundred ninety-one rupees" (Pakistani lakh/crore grouping) */
function inWords(n: number): string {
  if (n === 0) return 'Zero rupees';
  const neg = n < 0;
  let x = Math.abs(Math.round(n));
  const parts: string[] = [];
  const crore = Math.floor(x / 10_000_000);
  x %= 10_000_000;
  const lakh = Math.floor(x / 100_000);
  x %= 100_000;
  const thousand = Math.floor(x / 1000);
  x %= 1000;
  if (crore) parts.push(`${below1000(crore)} crore`);
  if (lakh) parts.push(`${below1000(lakh)} lakh`);
  if (thousand) parts.push(`${below1000(thousand)} thousand`);
  if (x) parts.push(below1000(x));
  const s = `${neg ? 'minus ' : ''}${parts.join(' ')} rupees`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function PayslipView() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['payroll', 'payslip', Number(id)], queryFn: () => payrollApi.payslip(Number(id)) });

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const p = q.data!;
  const back = can('payroll.view') ? { to: `/payroll/runs/${p.runId}`, label: `${month(p.periodMonth)} run` } : { to: '/me/payslips', label: 'My payslips' };

  return (
    <div>
      <style>{PRINT_CSS}</style>
      <div className="print:hidden">
        <PageHeader
          back={back}
          title={`${month(p.periodMonth)} payslip`}
          subtitle={p.name}
          actions={
            <>
              <button className="btn-secondary" onClick={() => window.print()}>
                <Printer {...ICON} className="text-ink-3" /> Print
              </button>
              <a className="btn-primary" href={payrollApi.payslipPdfUrl(p.id)}>
                <FileDown {...ICON} /> Download PDF
              </a>
            </>
          }
        />
      </div>
      <PayslipDocument p={p} />
    </div>
  );
}

function PayslipDocument({ p }: { p: Payslip }) {
  const lines = (s: 'A' | 'B' | 'C') => p.lines.filter((l) => l.section === s);
  return (
    <article className="card mx-auto max-w-[794px] px-8 py-8 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
      <header className="flex items-start justify-between gap-4 border-b border-line pb-5">
        <div>
          <p className="text-lg font-semibold">{p.company}</p>
          <p className="text-sm text-ink-3">Payslip for {month(p.periodMonth)}</p>
        </div>
        <div className="text-right">
          {p.runStatus === 'draft' ? <StatusTag value="draft" text="Draft, not final" /> : <StatusTag value={p.runStatus} />}
          {p.paidAt && <p className="mt-1 text-xs text-ink-3">Paid {date(p.paidAt.slice(0, 10))}</p>}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-x-8 gap-y-3 border-b border-line py-5 text-sm sm:grid-cols-3">
        <Item label="Employee" value={p.name} />
        <Item label="SIP ID" value={p.sipId} mono />
        <Item label="Designation" value={p.designationTitle ?? '—'} />
        <Item label="Department" value={p.departmentName ?? '—'} />
        <Item label="Employment" value={label(p.employmentStatus)} />
        <Item label="Joined" value={date(p.dateOfJoining)} />
        {p.cnic && <Item label="CNIC" value={p.cnic} mono />}
        <Item label="Bank" value={p.bankName ?? '—'} />
        <Item label="Account" value={p.accountNo ?? '—'} mono />
      </section>

      <section className="grid grid-cols-2 gap-x-8 gap-y-3 border-b border-line py-5 text-sm sm:grid-cols-4">
        <Item label={p.basis === 'working' ? 'Working days' : 'Days in month'} value={String(p.daysOfMonth)} mono />
        <Item label="Paid days" value={days(p.currentSalaryDays + p.newSalaryDays)} mono />
        <Item label="Unpaid leave" value={days(p.unpaidDays)} mono />
        <Item label="Before joining" value={days(p.notJoinedDays)} mono />
      </section>

      {p.periods.length > 0 && (
        <section className="border-b border-line py-5">
          <p className="mb-2 text-xs text-ink-3">Rate periods</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-ink-3">
                <th className="py-1 text-left font-normal">Period</th>
                <th className="py-1 text-right font-normal">Monthly gross</th>
                <th className="py-1 text-right font-normal">Paid days</th>
              </tr>
            </thead>
            <tbody>
              {p.periods.map((r) => (
                <tr key={r.from}>
                  <td className="py-1">
                    {date(r.from, true)} – {date(r.to, true)}
                  </td>
                  <td className="num py-1 text-right">{money(r.monthlyGross)}</td>
                  <td className="num py-1 text-right">
                    {days(r.paidDays)}
                    <span className="text-ink-3">/{p.daysOfMonth}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="grid gap-x-8 py-5 sm:grid-cols-2 print:grid-cols-2">
        <div>
          <Block code="A" title="Gross earned" total={p.grossA} lines={lines('A')} />
          <Block code="B" title="Additions" total={p.totalAdditionsB} lines={lines('B')} sign="+" />
        </div>
        <div>
          <Block code="C" title="Deductions" total={p.totalDeductionsC} lines={lines('C')} sign="−" />
        </div>
      </section>

      <section className="flex items-baseline gap-3 border-y-[3px] border-double border-ink/15 py-4">
        <span className="num w-4 text-xs text-ink-3">=</span>
        <span className="flex-1">
          <span className="text-sm font-medium">Net pay, PKR</span>
          <span className="block text-xs text-ink-3">{inWords(p.netTotal)}</span>
        </span>
        <span className="num text-xl font-medium text-brand print:text-ink">{money(p.netTotal)}</span>
      </section>

      <p className="mt-6 text-xs text-ink-3">
        Net = A + B − C. Gross earned is the monthly gross divided by {p.daysOfMonth} {p.basis === 'working' ? 'working' : 'calendar'} days, times the days paid at each rate. This payslip is computer generated and needs no signature.
      </p>
    </article>
  );
}

function Item({ label: l, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-ink-3">{l}</p>
      <p className={`mt-0.5 truncate ${mono ? 'num' : ''}`}>{value}</p>
    </div>
  );
}

function Block({ code, title, total, lines, sign }: { code: string; title: string; total: number; lines: Payslip['lines']; sign?: string }) {
  return (
    <div className="mb-4">
      <div className="flex items-baseline gap-3 border-b border-line pb-1.5">
        <span className="num w-4 text-xs text-ink-3">{code}</span>
        <span className="flex-1 text-sm font-medium">{title}</span>
        <span className="num text-sm">
          {sign && <span className="mr-1 text-ink-3">{sign}</span>}
          {money(total)}
        </span>
      </div>
      {lines.length === 0 ? (
        <p className="mt-1.5 pl-7 text-xs text-ink-3">None</p>
      ) : (
        <ul className="mt-1.5 space-y-1 pl-7">
          {lines.map((l) => (
            <li key={l.id} className="flex justify-between text-sm text-ink-2">
              <span>{l.component}</span>
              <span className="num">{money(l.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
