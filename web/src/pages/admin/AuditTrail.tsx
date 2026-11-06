import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, type Paged } from '../../lib/api';
import { dateTime, label } from '../../lib/format';
import { EmptyState, ErrorState, Field, Loading, PageHeader, Pagination, SearchInput, useDebounced } from '../../components/ui';

type Row = {
  id: number;
  action: string;
  entity: string;
  entityId: string | null;
  summary: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  userName: string | null;
};

const ENTITIES = [
  'employee',
  'employee_document',
  'candidate',
  'application',
  'interview',
  'payroll_run',
  'payslip',
  'salary_structure',
  'loan',
  'leave_application',
  'leave_type',
  'leave_ledger',
  'user',
  'role',
  'department',
  'designation',
  'settings',
];

/** Fields whose value changed between before and after. */
function changes(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: Array<{ key: string; from: unknown; to: unknown }> = [];
  for (const k of keys) {
    if (['updatedAt', 'createdAt'].includes(k)) continue;
    const a = before?.[k];
    const b = after?.[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ key: k, from: a, to: b });
  }
  return out;
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function AuditTrail() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [entity, setEntity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const debounced = useDebounced(search);

  const q = useQuery({
    queryKey: ['audit', page, debounced, entity, from, to],
    queryFn: () => api<Paged<Row>>('/audit', { query: { page, pageSize: 50, search: debounced, entity, from, to } }),
    placeholderData: (prev) => prev,
  });

  return (
    <div>
      <PageHeader eyebrow="Admin" title="Audit trail" subtitle="Every change, who made it and when. Entries are never edited or removed" />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-end gap-3 px-5 py-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search summary or record ID"
            className="w-full max-w-xs"
          />
          <Field label="Record type" className="w-48">
            <select
              className="input"
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              {ENTITIES.map((e) => (
                <option key={e} value={e}>
                  {label(e)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From" className="w-40">
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" className="w-40">
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        {q.isLoading ? (
          <Loading inline />
        ) : q.error ? (
          <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
        ) : q.data!.data.length === 0 ? (
          <EmptyState bare title="No entries" hint="Change the filters to see more" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="th w-8" />
                    <th className="th">When</th>
                    <th className="th">Who</th>
                    <th className="th">What</th>
                    <th className="th">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data!.data.map((r) => {
                    const diff = changes(r.before, r.after);
                    const expandable = diff.length > 0;
                    return (
                      <Fragment key={r.id}>
                        <tr className={expandable ? 'row-link' : ''} onClick={() => expandable && setOpen(open === r.id ? null : r.id)}>
                          <td className="td pr-0 text-ink-3">
                            {expandable && (open === r.id ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />)}
                          </td>
                          <td className="td num text-xs text-ink-3">{dateTime(r.createdAt)}</td>
                          <td className="td">{r.userName ?? 'System'}</td>
                          <td className="td whitespace-normal text-ink-2">{r.summary ?? `${label(r.action)} ${label(r.entity).toLowerCase()}`}</td>
                          <td className="td">
                            <span className="text-xs text-ink-3">{label(r.entity)}</span>{' '}
                            {r.entityId && <span className="num text-xs text-ink-2">{r.entityId}</span>}
                          </td>
                        </tr>
                        {open === r.id && (
                          <tr>
                            <td />
                            <td colSpan={4} className="px-5 pb-4">
                              <table className="w-full max-w-3xl text-xs">
                                <thead>
                                  <tr className="text-left text-ink-3">
                                    <th className="py-1 pr-4 font-normal">Field</th>
                                    <th className="py-1 pr-4 font-normal">Before</th>
                                    <th className="py-1 font-normal">After</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {diff.map((c) => (
                                    <tr key={c.key} className="border-t border-line align-top">
                                      <td className="py-1.5 pr-4 text-ink-2">{label(c.key.replace(/([A-Z])/g, '_$1').toLowerCase())}</td>
                                      <td className="num max-w-xs break-all py-1.5 pr-4 text-ink-3">{show(c.from)}</td>
                                      <td className="num max-w-xs break-all py-1.5">{show(c.to)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination meta={q.data!.meta} onPage={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
