import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { payrollApi, type StructureListRow } from '../../api/payroll';
import {
  EmptyState,
  ErrorState,
  ICON,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Segmented,
  SipId,
  StatusTag,
  Tag,
  toast,
  useDebounced,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { date, money } from '../../lib/format';
import { DepartmentSelect, Flags, StructureModal } from './shared';

export function SalaryStructures() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [dept, setDept] = useState<number | ''>('');
  const [filter, setFilter] = useState<'all' | 'missing'>('all');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<StructureListRow | null>(null);

  const q = useQuery({
    queryKey: ['payroll', 'structures', debounced, dept, filter, page],
    queryFn: () => payrollApi.structures({ page, search: debounced, departmentId: dept, missing: filter === 'missing' }),
  });

  return (
    <div>
      <PageHeader
        eyebrow="Payroll"
        title="Salary structures"
        subtitle="Each employee's current gross and its breakdown. A change adds a new row from its effective date"
        actions={
          can('payroll.manage') && (
            <button className="btn-primary" onClick={() => setAdding(true)}>
              <Plus {...ICON} /> Add salary
            </button>
          )
        }
      />

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search name or SIP ID"
            className="w-full max-w-xs"
          />
          <DepartmentSelect
            value={dept}
            onChange={(v) => {
              setDept(v);
              setPage(1);
            }}
          />
          <Segmented
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setPage(1);
            }}
            options={[
              { value: 'all', label: 'All' },
              { value: 'missing', label: `Missing structure${q.data ? ` (${q.data.meta.missing})` : ''}` },
            ]}
          />
        </div>
        {q.isLoading ? (
          <Loading inline label="Loading salaries" />
        ) : q.error ? (
          <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
        ) : q.data!.data.length === 0 ? (
          <EmptyState
            bare
            title={filter === 'missing' ? 'Everyone has a salary structure' : 'No employees match'}
            hint={filter === 'missing' ? 'New hires without a salary show up here' : 'Try another name, SIP ID or department'}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="th">Employee</th>
                    <th className="th">Since</th>
                    <th className="th text-right">Basic</th>
                    <th className="th text-right">Allowances</th>
                    <th className="th text-right">Gross, PKR</th>
                    <th className="th">Deductions</th>
                    <th className="th">Next change</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data!.data.map((r) => (
                    <tr key={r.sipId} className="row-link" onClick={() => setOpen(r)}>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{r.name}</span>
                          <SipId id={r.sipId} />
                          {r.status !== 'active' && <StatusTag value={r.status} />}
                        </div>
                        <p className="mt-0.5 text-xs text-ink-3">{[r.designationTitle, r.departmentName].filter(Boolean).join(', ') || 'No department'}</p>
                      </td>
                      {r.current ? (
                        <>
                          <td className="td text-ink-2">{date(r.current.effectiveFrom)}</td>
                          <td className="td num text-right">{money(r.current.basicSalary)}</td>
                          <td className="td num text-right text-ink-2">{money(r.current.grossSalary - r.current.basicSalary)}</td>
                          <td className="td num text-right font-medium">{money(r.current.grossSalary)}</td>
                          <td className="td">
                            <Flags s={r.current} />
                          </td>
                        </>
                      ) : (
                        <td className="td" colSpan={5}>
                          <Tag tone="warn">No salary structure</Tag>
                        </td>
                      )}
                      <td className="td text-ink-2">
                        {r.next ? (
                          <span>
                            <span className="num">{money(r.next.grossSalary)}</span> from {date(r.next.effectiveFrom)}
                          </span>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination meta={q.data!.meta} onPage={setPage} />
          </>
        )}
      </div>

      <StructureModal open={adding} onClose={() => setAdding(false)} />
      {open && <HistoryModal row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function HistoryModal({ row, onClose }: { row: StructureListRow; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [increment, setIncrement] = useState(false);
  const q = useQuery({ queryKey: ['payroll', 'structure', row.sipId], queryFn: () => payrollApi.structureHistory(row.sipId) });
  const del = useMutation({
    mutationFn: (id: number) => payrollApi.deleteStructure(id),
    onSuccess: () => {
      toast('Planned change removed');
      void qc.invalidateQueries({ queryKey: ['payroll'] });
    },
    onError: (e) => toast(e.message, 'bad'),
  });

  return (
    <>
    <Modal open={!increment} wide title={row.name} onClose={onClose}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-ink-2">
          <SipId id={row.sipId} to={`/employees/${row.sipId}`} /> Joined {date(row.dateOfJoining)}
        </div>
        {can('payroll.manage') && (
          <button className="btn-primary btn-sm" onClick={() => setIncrement(true)}>
            <Plus {...ICON} /> {q.data?.current ? 'Add increment' : 'Add salary'}
          </button>
        )}
      </div>
      {q.isLoading ? (
        <Loading inline />
      ) : q.error ? (
        <ErrorState message={q.error.message} />
      ) : q.data!.data.length === 0 ? (
        <EmptyState bare title="No salary yet" hint="Add a salary from the joining date so this person is included in payroll" />
      ) : (
        <div className="-mx-6 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="th">From</th>
                <th className="th text-right">Basic</th>
                <th className="th text-right">House rent</th>
                <th className="th text-right">Medical</th>
                <th className="th text-right">Petrol</th>
                <th className="th text-right">Other</th>
                <th className="th text-right">Gross</th>
                <th className="th">Deductions</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {q.data!.data.map((s) => (
                <tr key={s.id}>
                  <td className="td">
                    <span className="flex items-center gap-2">
                      {date(s.effectiveFrom)}
                      {s.isCurrent && <Tag tone="good">Current</Tag>}
                      {s.isFuture && <Tag tone="brand">Planned</Tag>}
                    </span>
                    {s.note && <p className="mt-0.5 text-xs text-ink-3">{s.note}</p>}
                  </td>
                  <td className="td num text-right">{money(s.basicSalary)}</td>
                  <td className="td num text-right text-ink-2">{money(s.houseRent)}</td>
                  <td className="td num text-right text-ink-2">{money(s.medicalAllowance)}</td>
                  <td className="td num text-right text-ink-2">{money(s.petrolAllowance)}</td>
                  <td className="td num text-right text-ink-2">{money(s.otherAllowance)}</td>
                  <td className="td num text-right font-medium">{money(s.grossSalary)}</td>
                  <td className="td">
                    <Flags s={s} />
                  </td>
                  <td className="td text-right">
                    {s.isFuture && can('payroll.manage') && (
                      <button className="icon-btn" aria-label="Remove planned change" title="Remove planned change" onClick={() => del.mutate(s.id)}>
                        <Trash2 {...ICON} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
    <StructureModal open={increment} onClose={() => setIncrement(false)} employee={{ sipId: row.sipId, name: row.name }} current={q.data?.data[0] ?? null} />
    </>
  );
}
