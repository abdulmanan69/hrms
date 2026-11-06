/** Pieces shared by the payroll pages: the A + B − C ledger, pickers, salary form. */
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { departmentsList, payrollApi, people, type Skipped, type Structure } from '../../api/payroll';
import { Field, FormError, Modal, SipId, toast, useDebounced } from '../../components/ui';
import { date, money, todayISO } from '../../lib/format';

/* ------------------------------------------------------------------ */
/* Ledger                                                               */
/* ------------------------------------------------------------------ */

export interface LedgerSection {
  key: 'A' | 'B' | 'C';
  label: string;
  total: number;
  lines: Array<{ name: ReactNode; amount: number; key?: string | number; action?: ReactNode }>;
  empty?: string;
}

/** The run or payslip as the salary sheet reads it: A + B − C, ruled like a ledger. */
export function Ledger({ sections, net, netLabel = 'Net, PKR', footer }: { sections: LedgerSection[]; net: number; netLabel?: string; footer?: ReactNode }) {
  const sign = { A: '', B: '+', C: '−' } as const;
  return (
    <div>
      {sections.map((s) => (
        <div key={s.key} className="border-t border-line py-3 first:border-t-0 first:pt-1">
          <div className="flex items-baseline gap-3">
            <span className="num w-4 text-xs text-ink-3">{s.key}</span>
            <span className="flex-1 text-sm">{s.label}</span>
            <span className="num text-sm">
              {sign[s.key] && <span className="mr-1 text-ink-3">{sign[s.key]}</span>}
              {money(s.total)}
            </span>
          </div>
          {s.lines.length > 0 ? (
            <ul className="mt-1.5 space-y-1 pl-7">
              {s.lines.map((l, i) => (
                <li key={l.key ?? i} className="flex items-center justify-between gap-2 text-xs text-ink-3">
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  <span className="num">{money(l.amount)}</span>
                  {l.action}
                </li>
              ))}
            </ul>
          ) : (
            s.empty && <p className="mt-1.5 pl-7 text-xs text-ink-3">{s.empty}</p>
          )}
        </div>
      ))}
      <div className="flex items-baseline gap-3 border-y-[3px] border-double border-ink/15 py-3">
        <span className="num w-4 text-xs text-ink-3">=</span>
        <span className="flex-1 text-sm font-medium">{netLabel}</span>
        <span className={`num text-base font-medium ${net < 0 ? 'text-bad' : 'text-brand'}`}>{money(net)}</span>
      </div>
      {footer}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Skipped employees                                                    */
/* ------------------------------------------------------------------ */

export function SkippedList({ skipped, title = 'Not included' }: { skipped: Skipped[]; title?: string }) {
  if (skipped.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="mb-2 text-sm text-ink-2">
        {title} <span className="num text-xs text-ink-3">{skipped.length}</span>
      </p>
      <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {skipped.map((s) => (
          <li key={s.sipId + s.reason} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="truncate">{s.name}</span>
            <SipId id={s.sipId} to={`/employees/${s.sipId}`} />
            <span className="ml-auto shrink-0 text-xs text-ink-3">{s.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Employee picker                                                      */
/* ------------------------------------------------------------------ */

export function PersonPicker({ value, onChange }: { value: { sipId: string; name: string } | null; onChange: (p: { sipId: string; name: string } | null) => void }) {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const list = useQuery({ queryKey: ['payroll', 'people', debounced], queryFn: () => people(debounced), enabled: !value });
  if (value) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-lg border border-line px-3">
        <span className="truncate text-sm">{value.name}</span>
        <SipId id={value.sipId} />
        <button type="button" className="ml-auto text-xs text-ink-3 transition-colors hover:text-ink" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div>
      <input className="input" placeholder="Search by name or SIP ID" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
      <ul className="mt-1 max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {(list.data?.data ?? [])
          .filter((p) => p.status !== 'inactive')
          .map((p) => (
            <li key={p.sipId}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-bg"
                onClick={() => onChange({ sipId: p.sipId, name: p.name })}
              >
                <span className="truncate">{p.name}</span>
                <SipId id={p.sipId} />
                <span className="ml-auto truncate text-xs text-ink-3">{p.departmentName ?? ''}</span>
              </button>
            </li>
          ))}
        {list.data && list.data.data.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">No one matches</li>}
      </ul>
    </div>
  );
}

export function DepartmentSelect({ value, onChange }: { value: number | ''; onChange: (v: number | '') => void }) {
  const q = useQuery({ queryKey: ['payroll', 'departments'], queryFn: departmentsList, staleTime: 60_000 });
  return (
    <select className="input w-auto min-w-44" value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} aria-label="Department">
      <option value="">All departments</option>
      {q.data?.data.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  );
}

/** Whole-rupee input that keeps the field editable while typing. */
export function MoneyInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  return <input id={id} className="input num text-right" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))} />;
}

/* ------------------------------------------------------------------ */
/* Add salary structure / increment                                     */
/* ------------------------------------------------------------------ */

const PARTS = [
  ['basicSalary', 'Basic'],
  ['houseRent', 'House rent'],
  ['medicalAllowance', 'Medical'],
  ['petrolAllowance', 'Petrol'],
  ['otherAllowance', 'Other allowance'],
] as const;
type PartKey = (typeof PARTS)[number][0];

/**
 * New hire's first salary or an increment. Edits never rewrite history:
 * every save is a new row from its effective date.
 */
export function StructureModal({
  open,
  onClose,
  employee,
  current,
}: {
  open: boolean;
  onClose: () => void;
  /** fixed employee; omit to pick one */
  employee?: { sipId: string; name: string };
  current?: Structure | null;
}) {
  const qc = useQueryClient();
  const [person, setPerson] = useState<{ sipId: string; name: string } | null>(employee ?? null);
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO());
  const [parts, setParts] = useState<Record<PartKey, string>>({ basicSalary: '', houseRent: '', medicalAllowance: '', petrolAllowance: '', otherAllowance: '' });
  const [flags, setFlags] = useState({ pfApplicable: true, eobiApplicable: true, whtApplicable: true });
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setPerson(employee ?? null);
    setEffectiveFrom(todayISO());
    setNote('');
    setParts({
      basicSalary: current ? String(current.basicSalary) : '',
      houseRent: current ? String(current.houseRent) : '',
      medicalAllowance: current ? String(current.medicalAllowance) : '',
      petrolAllowance: current ? String(current.petrolAllowance) : '',
      otherAllowance: current ? String(current.otherAllowance) : '',
    });
    setFlags({
      pfApplicable: current?.pfApplicable ?? true,
      eobiApplicable: current?.eobiApplicable ?? true,
      whtApplicable: current?.whtApplicable ?? true,
    });
    // reset whenever the modal opens for someone
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee?.sipId, current?.id]);

  const n = (k: PartKey) => Number(parts[k] || 0);
  const gross = PARTS.reduce((s, [k]) => s + n(k), 0);

  const save = useMutation({
    mutationFn: () =>
      payrollApi.addStructure({
        sipId: person!.sipId,
        effectiveFrom,
        basicSalary: n('basicSalary'),
        houseRent: n('houseRent'),
        medicalAllowance: n('medicalAllowance'),
        petrolAllowance: n('petrolAllowance'),
        otherAllowance: n('otherAllowance'),
        ...flags,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      toast(current ? 'Increment saved' : 'Salary saved');
      void qc.invalidateQueries({ queryKey: ['payroll'] });
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={current ? 'Add increment' : 'Add salary'}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!person || !n('basicSalary') || !effectiveFrom || save.isPending} onClick={() => save.mutate()}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {!employee && (
          <Field label="Employee" required>
            <PersonPicker value={person} onChange={setPerson} />
          </Field>
        )}
        {current && (
          <p className="text-sm text-ink-2">
            Current gross <span className="num text-ink">{money(current.grossSalary)}</span> since {date(current.effectiveFrom)}. The new
            amounts apply from the effective date; earlier months keep the old rate.
          </p>
        )}
        <Field label="Effective from" required hint="A date inside a month splits that month into two rate periods">
          <input type="date" className="input" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {PARTS.map(([k, l]) => (
            <Field key={k} label={l} required={k === 'basicSalary'}>
              <MoneyInput value={parts[k]} onChange={(v) => setParts((p) => ({ ...p, [k]: v }))} />
            </Field>
          ))}
          <div>
            <span className="mb-1.5 block text-sm text-ink-2">Gross, PKR</span>
            <p className="num flex h-9 items-center justify-end rounded-lg bg-raised px-3 text-sm font-medium">
              {money(gross)}
              {current && gross !== current.grossSalary && (
                <span className="ml-2 text-xs font-normal text-ink-3">
                  {gross > current.grossSalary ? '+' : '−'}
                  {money(Math.abs(gross - current.grossSalary))}
                </span>
              )}
            </p>
          </div>
        </div>
        <div>
          <span className="mb-1.5 block text-sm text-ink-2">Deductions that apply</span>
          <div className="flex flex-wrap gap-4">
            {(
              [
                ['pfApplicable', 'Provident fund'],
                ['eobiApplicable', 'EOBI'],
                ['whtApplicable', 'Withholding tax'],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={flags[k]} onChange={(e) => setFlags((f) => ({ ...f, [k]: e.target.checked }))} />
                {l}
              </label>
            ))}
          </div>
        </div>
        <Field label="Note">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Annual increment, promotion, new hire" />
        </Field>
        <FormError message={save.error?.message} />
      </div>
    </Modal>
  );
}

/** Small "yes/no" chips for PF / EOBI / WHT. */
export function Flags({ s }: { s: Pick<Structure, 'pfApplicable' | 'eobiApplicable' | 'whtApplicable'> }) {
  const items = [
    ['PF', s.pfApplicable],
    ['EOBI', s.eobiApplicable],
    ['WHT', s.whtApplicable],
  ] as const;
  return (
    <span className="inline-flex gap-1.5 text-xs">
      {items.map(([l, on]) => (
        <span key={l} className={on ? 'text-ink-2' : 'text-ink-3 line-through'}>
          {l}
        </span>
      ))}
    </span>
  );
}
