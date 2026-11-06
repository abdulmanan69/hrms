import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { payrollApi, type LoanRow } from '../../api/payroll';
import {
  EmptyState,
  ErrorState,
  Field,
  FormError,
  ICON,
  Loading,
  Modal,
  PageHeader,
  SearchInput,
  Segmented,
  SipId,
  Tag,
  toast,
  useDebounced,
  type Tone,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { date, money, month, todayISO } from '../../lib/format';
import { MoneyInput, PersonPicker } from './shared';

const ENTRY: Record<string, { text: string; tone: Tone }> = {
  loan: { text: 'Loan', tone: 'neutral' },
  advance: { text: 'Advance', tone: 'neutral' },
  deduction: { text: 'Repaid', tone: 'good' },
  waiver: { text: 'Waived', tone: 'warn' },
};

export function LoansAdvances() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [show, setShow] = useState<'outstanding' | 'all'>('outstanding');
  const [giving, setGiving] = useState<{ sipId: string; name: string } | null | 'new'>(null);
  const [open, setOpen] = useState<{ sipId: string; name: string } | null>(null);
  const q = useQuery({ queryKey: ['payroll', 'loans', debounced, show], queryFn: () => payrollApi.loans({ search: debounced, all: show === 'all' }) });
  const total = (q.data?.data ?? []).reduce((n, r) => n + r.balance, 0);

  return (
    <div>
      <PageHeader
        eyebrow="Payroll"
        title="Loans and advances"
        subtitle="Outstanding balances are recovered through payroll at each person's monthly installment"
        actions={
          can('payroll.manage') && (
            <button className="btn-primary" onClick={() => setGiving('new')}>
              <Plus {...ICON} /> Give loan or advance
            </button>
          )
        }
      />

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search name or SIP ID" className="w-full max-w-xs" />
          <Segmented
            value={show}
            onChange={setShow}
            options={[
              { value: 'outstanding', label: 'Outstanding' },
              { value: 'all', label: 'All' },
            ]}
          />
          {q.data && q.data.data.length > 0 && (
            <p className="ml-auto text-sm text-ink-2">
              Outstanding <span className="num font-medium text-ink">{money(total)}</span> PKR
            </p>
          )}
        </div>
        {q.isLoading ? (
          <Loading inline label="Loading balances" />
        ) : q.error ? (
          <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
        ) : q.data!.data.length === 0 ? (
          <EmptyState bare title="No outstanding loans or advances" hint="Loans and advances you give appear here until they are repaid" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Employee</th>
                  <th className="th">Last entry</th>
                  <th className="th text-right">Installment</th>
                  <th className="th text-right">Balance, PKR</th>
                </tr>
              </thead>
              <tbody>
                {q.data!.data.map((r: LoanRow) => (
                  <tr key={r.sipId} className="row-link" onClick={() => setOpen({ sipId: r.sipId, name: r.name })}>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        <SipId id={r.sipId} />
                      </div>
                      <p className="mt-0.5 text-xs text-ink-3">{r.departmentName ?? 'No department'}</p>
                    </td>
                    <td className="td text-ink-2">{date(r.lastEntryDate)}</td>
                    <td className="td num text-right text-ink-2">{money(r.installment)}</td>
                    <td className="td num text-right font-medium">{money(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {giving && <GiveModal employee={giving === 'new' ? null : giving} onClose={() => setGiving(null)} />}
      {open && !giving && <LedgerModal employee={open} onClose={() => setOpen(null)} onGive={() => setGiving(open)} />}
    </div>
  );
}

function LedgerModal({ employee, onClose, onGive }: { employee: { sipId: string; name: string }; onClose: () => void; onGive: () => void }) {
  const { can } = useAuth();
  const [entry, setEntry] = useState<'repayment' | 'waiver' | null>(null);
  const q = useQuery({ queryKey: ['payroll', 'loan', employee.sipId], queryFn: () => payrollApi.loanLedger(employee.sipId) });
  const balance = q.data?.balance ?? 0;

  if (entry) return <EntryModal sipId={employee.sipId} type={entry} balance={balance} onClose={() => setEntry(null)} />;

  return (
    <Modal open wide title={employee.name} onClose={onClose}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-ink-2">
          <SipId id={employee.sipId} to={`/employees/${employee.sipId}`} /> Balance{' '}
          <span className="num font-medium text-ink">{money(balance)}</span>, installment <span className="num">{money(q.data?.installment ?? 0)}</span> a month
        </div>
        {can('payroll.manage') && (
          <div className="flex gap-2">
            <button className="btn-secondary btn-sm" disabled={balance <= 0} onClick={() => setEntry('repayment')}>
              Record repayment
            </button>
            <button className="btn-secondary btn-sm" disabled={balance <= 0} onClick={() => setEntry('waiver')}>
              Waive
            </button>
            <button className="btn-primary btn-sm" onClick={onGive}>
              <Plus {...ICON} /> Give more
            </button>
          </div>
        )}
      </div>
      {q.isLoading ? (
        <Loading inline />
      ) : q.error ? (
        <ErrorState message={q.error.message} />
      ) : (
        <div className="-mx-6 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="th">Date</th>
                <th className="th">Entry</th>
                <th className="th">Note</th>
                <th className="th text-right">Amount</th>
                <th className="th text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.data.map((e) => (
                <tr key={e.id}>
                  <td className="td text-ink-2">{date(e.entryDate)}</td>
                  <td className="td">
                    <Tag tone={ENTRY[e.entryType].tone}>{e.runId ? 'Payroll deduction' : ENTRY[e.entryType].text}</Tag>
                  </td>
                  <td className="td text-ink-2">
                    {e.runId && e.periodMonth ? (
                      <Link className="transition-colors hover:text-ink" to={`/payroll/runs/${e.runId}`}>
                        {month(e.periodMonth)} run
                      </Link>
                    ) : (
                      e.note ?? '—'
                    )}
                    {e.installment ? <span className="text-xs text-ink-3"> · {money(e.installment)} a month</span> : null}
                  </td>
                  <td className="td num text-right">
                    {e.amount > 0 ? '+' : '−'}
                    {money(Math.abs(e.amount))}
                  </td>
                  <td className="td num text-right font-medium">{money(e.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function GiveModal({ employee, onClose }: { employee: { sipId: string; name: string } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [person, setPerson] = useState(employee);
  const [type, setType] = useState<'loan' | 'advance'>('loan');
  const [amount, setAmount] = useState('');
  const [installment, setInstallment] = useState('');
  const [entryDate, setEntryDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () =>
      payrollApi.giveLoan({ sipId: person!.sipId, type, amount: Number(amount), installment: Number(installment), entryDate, note: note.trim() || undefined }),
    onSuccess: () => {
      toast(type === 'loan' ? 'Loan recorded' : 'Advance recorded');
      void qc.invalidateQueries({ queryKey: ['payroll'] });
      onClose();
    },
  });
  const months = Number(amount) && Number(installment) ? Math.ceil(Number(amount) / Number(installment)) : null;

  return (
    <Modal
      open
      title="Give loan or advance"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!person || !Number(amount) || !Number(installment) || save.isPending} onClick={() => save.mutate()}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Employee" required>
          <PersonPicker value={person} onChange={setPerson} />
        </Field>
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { value: 'loan', label: 'Loan' },
            { value: 'advance', label: 'Advance' },
          ]}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount, PKR" required>
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>
          <Field label="Monthly installment" required hint={months ? `About ${months} months` : 'Deducted in each payroll run'}>
            <MoneyInput value={installment} onChange={setInstallment} />
          </Field>
        </div>
        <Field label="Date given">
          <input type="date" className="input" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
        </Field>
        <Field label="Note">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason or approval reference" />
        </Field>
        <FormError message={save.error?.message} />
      </div>
    </Modal>
  );
}

function EntryModal({ sipId, type, balance, onClose }: { sipId: string; type: 'repayment' | 'waiver'; balance: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(String(balance));
  const [entryDate, setEntryDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => payrollApi.loanEntry(sipId, { type, amount: Number(amount), entryDate, note: note.trim() || undefined }),
    onSuccess: () => {
      toast(type === 'waiver' ? 'Waiver recorded' : 'Repayment recorded');
      void qc.invalidateQueries({ queryKey: ['payroll'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      title={type === 'waiver' ? 'Waive balance' : 'Record repayment'}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!Number(amount) || save.isPending} onClick={() => save.mutate()}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Amount, PKR" hint={`Outstanding ${money(balance)}`}>
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
        <Field label="Date">
          <input type="date" className="input" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
        </Field>
        <Field label="Note">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={type === 'waiver' ? 'Approved by' : 'Cash, bank transfer'} />
        </Field>
        <FormError message={save.error?.message} />
      </div>
    </Modal>
  );
}
