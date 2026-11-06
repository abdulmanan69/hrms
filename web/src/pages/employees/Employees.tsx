import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, Plus } from 'lucide-react';
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
import { date, label } from '../../lib/format';
import { EMPLOYMENT_STATUSES, empKeys, employeesApi, type BulkResult, type EmployeeFilters } from '../../api/employees';
import { ReasonModal, useInvalidateEmployees } from './parts';

type StatusFilter = 'all' | 'active' | 'pending' | 'inactive';

/** Pending reads as "Pending activation" across the register. */
export function statusText(s: string): string {
  return s === 'pending' ? 'Pending activation' : label(s);
}

export function Employees() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const manage = can('employees.manage');
  const broad = can('employees.view');
  const invalidate = useInvalidateEmployees();
  const [params, setParams] = useSearchParams();
  const p = (k: string) => params.get(k) ?? '';

  // Search box mirrors ?search= (the top bar search sends people here).
  const urlSearch = p('search');
  const [searchText, setSearchText] = useState(urlSearch);
  const debounced = useDebounced(searchText);
  useEffect(() => setSearchText(urlSearch), [urlSearch]);
  useEffect(() => {
    if (debounced !== urlSearch) set({ search: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  function set(next: Record<string, string>) {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) (v ? n.set(k, v) : n.delete(k));
    if (!('page' in next)) n.delete('page');
    setParams(n, { replace: true });
  }

  const status = (p('status') || 'all') as StatusFilter;
  const filters: EmployeeFilters = {
    search: urlSearch || undefined,
    departmentId: p('departmentId') || undefined,
    designationId: p('designationId') || undefined,
    status,
    employmentStatus: p('employmentStatus') || undefined,
    managerSipId: p('managerSipId') || undefined,
    sort: p('sort') || 'name',
    dir: p('dir') || 'asc',
    page: Number(p('page')) || 1,
    pageSize: 25,
  };

  const list = useQuery({ queryKey: empKeys.list(filters), queryFn: () => employeesApi.list(filters), placeholderData: keepPreviousData });
  const summaryFilters = { ...filters, status: undefined, page: undefined, sort: undefined, dir: undefined };
  const summary = useQuery({ queryKey: empKeys.summary(summaryFilters), queryFn: () => employeesApi.summary(summaryFilters) });
  const depts = useQuery({ queryKey: empKeys.departments, queryFn: employeesApi.departments });
  const desigs = useQuery({ queryKey: empKeys.designations, queryFn: employeesApi.designations });
  const managers = useQuery({
    queryKey: empKeys.people({ status: 'active', limit: 500 }),
    queryFn: () => employeesApi.people({ status: 'active', limit: 500 }),
    enabled: broad,
  });

  const designationOptions = useMemo(
    () => (desigs.data?.data ?? []).filter((d) => !filters.departmentId || String(d.departmentId) === filters.departmentId),
    [desigs.data, filters.departmentId],
  );

  /* selection and bulk actions */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const filterKey = JSON.stringify({ ...filters, page: undefined });
  useEffect(() => setSelected(new Set()), [filterKey]);
  const rows = list.data?.data ?? [];
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.sipId));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allOnPage) rows.forEach((r) => n.delete(r.sipId));
      else rows.forEach((r) => n.add(r.sipId));
      return n;
    });

  const [deactivating, setDeactivating] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const bulk = useMutation({
    mutationFn: (v: { action: 'activate' | 'deactivate'; reason?: string }) => employeesApi.bulkStatus([...selected], v.action, v.reason),
    onSuccess: (res) => {
      invalidate();
      setDeactivating(false);
      setSelected(new Set());
      if (res.failed === 0) toast(`${res.succeeded} ${res.succeeded === 1 ? 'record' : 'records'} updated`);
      else setResult(res);
    },
  });

  const sortBy = (key: string) => {
    if (filters.sort === key) set({ dir: filters.dir === 'asc' ? 'desc' : 'asc' });
    else set({ sort: key, dir: key === 'dateOfJoining' ? 'desc' : 'asc' });
  };
  const SortHead = ({ k, children, className = '' }: { k: string; children: string; className?: string }) => (
    <th className={`th ${className}`}>
      <button className="inline-flex items-center gap-1 transition-colors hover:text-ink" onClick={() => sortBy(k)}>
        {children}
        {filters.sort === k && (filters.dir === 'asc' ? <ArrowUp size={12} strokeWidth={1.5} /> : <ArrowDown size={12} strokeWidth={1.5} />)}
      </button>
    </th>
  );

  const s = summary.data;
  const anyFilter = !!(filters.search || filters.departmentId || filters.designationId || filters.employmentStatus || filters.managerSipId);

  return (
    <div className="rise">
      <PageHeader
        title="Employees"
        subtitle={
          s ? (
            <>
              <span className="num">{s.active}</span> active, <span className="num">{s.pending}</span> pending activation,{' '}
              <span className="num">{s.inactive}</span> inactive
            </>
          ) : (
            broad ? 'The staff register' : 'Your direct reports'
          )
        }
        actions={
          <>
            <a className="btn-secondary" href={employeesApi.exportUrl(filters)}>
              <Download {...ICON} className="text-ink-3" />
              Export
            </a>
            {manage && (
              <Link to="/employees/new" className="btn-primary">
                <Plus {...ICON} />
                Add employee
              </Link>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Segmented<StatusFilter>
          value={status}
          onChange={(v) => set({ status: v === 'all' ? '' : v })}
          options={[
            { value: 'all', label: s ? `All ${s.total}` : 'All' },
            { value: 'active', label: s ? `Active ${s.active}` : 'Active' },
            { value: 'pending', label: s ? `Pending activation ${s.pending}` : 'Pending activation' },
            { value: 'inactive', label: s ? `Inactive ${s.inactive}` : 'Inactive' },
          ]}
        />
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(240px,2fr)_repeat(4,minmax(0,1fr))]">
        <SearchInput value={searchText} onChange={setSearchText} placeholder="Search by SIP ID, name, CNIC, email or phone" />
        <select className="input" value={filters.departmentId ?? ''} onChange={(e) => set({ departmentId: e.target.value, designationId: '' })} aria-label="Department">
          <option value="">All departments</option>
          {(depts.data?.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select className="input" value={filters.designationId ?? ''} onChange={(e) => set({ designationId: e.target.value })} aria-label="Designation">
          <option value="">All designations</option>
          {designationOptions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
        <select className="input" value={filters.employmentStatus ?? ''} onChange={(e) => set({ employmentStatus: e.target.value })} aria-label="Employment status">
          <option value="">Any employment</option>
          {EMPLOYMENT_STATUSES.map((v) => (
            <option key={v} value={v}>
              {label(v)}
            </option>
          ))}
        </select>
        {broad && (
          <select className="input" value={filters.managerSipId ?? ''} onChange={(e) => set({ managerSipId: e.target.value })} aria-label="Manager">
            <option value="">Any manager</option>
            {(managers.data?.data ?? []).map((m) => (
              <option key={m.sipId} value={m.sipId}>
                {m.name} ({m.sipId})
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="mt-6">
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorState message={list.error.message} onRetry={() => list.refetch()} />
        ) : (
          <div className="card overflow-hidden">
            {manage && selected.size > 0 ? (
              <div className="card-head">
                <p className="text-sm">
                  <span className="num">{selected.size}</span> selected
                </p>
                <div className="flex items-center gap-2">
                  <button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
                    Clear
                  </button>
                  <button className="btn-secondary btn-sm" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: 'activate' })}>
                    Activate
                  </button>
                  <button className="btn-secondary btn-sm" disabled={bulk.isPending} onClick={() => setDeactivating(true)}>
                    Deactivate
                  </button>
                </div>
              </div>
            ) : (
              <div className="card-head">
                <p className="card-title">{statusText(status === 'all' ? 'all_employees' : status)}</p>
                <p className="num text-xs text-ink-3">{list.data?.meta.total ?? 0}</p>
              </div>
            )}
            {rows.length === 0 ? (
              <EmptyState
                bare
                title={anyFilter || status !== 'all' ? 'No employees match these filters' : 'No employees yet'}
                hint={
                  anyFilter || status !== 'all'
                    ? 'Clear the search or filters to see everyone'
                    : 'People appear here when they are hired in Recruitment or added directly'
                }
                action={
                  anyFilter || status !== 'all' ? (
                    <button className="btn-secondary btn-sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                      Clear filters
                    </button>
                  ) : manage ? (
                    <Link to="/employees/new" className="btn-primary btn-sm">
                      Add employee
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      {manage && (
                        <th className="th w-10 pr-0">
                          <input type="checkbox" checked={allOnPage} onChange={toggleAll} aria-label="Select all on this page" />
                        </th>
                      )}
                      <SortHead k="name">Employee</SortHead>
                      <SortHead k="department">Department</SortHead>
                      <SortHead k="designation">Designation</SortHead>
                      <th className="th">Employment</th>
                      <SortHead k="status">Status</SortHead>
                      <SortHead k="dateOfJoining" className="text-right">
                        Joined
                      </SortHead>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.sipId} className="row-link" onClick={() => navigate(`/employees/${r.sipId}`)}>
                        {manage && (
                          <td className="td w-10 pr-0" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={selected.has(r.sipId)} onChange={() => toggle(r.sipId)} aria-label={`Select ${r.name}`} />
                          </td>
                        )}
                        <td className="td">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{r.name}</span>
                            <SipId id={r.sipId} />
                          </div>
                          {r.managerName && <p className="mt-0.5 text-xs text-ink-3">Reports to {r.managerName}</p>}
                        </td>
                        <td className="td text-ink-2">{r.departmentName ?? '—'}</td>
                        <td className="td text-ink-2">{r.designationTitle ?? '—'}</td>
                        <td className="td">
                          <StatusTag value={r.employmentStatus} />
                        </td>
                        <td className="td">
                          <StatusTag value={r.status} text={statusText(r.status)} />
                        </td>
                        <td className="td num text-right text-ink-2">{date(r.dateOfJoining)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {list.data && <Pagination meta={list.data.meta} onPage={(pg) => set({ page: String(pg) })} />}
          </div>
        )}
      </div>

      <ReasonModal
        open={deactivating}
        title={`Deactivate ${selected.size} ${selected.size === 1 ? 'employee' : 'employees'}`}
        body="They leave payroll and leave from today. Records are kept and can be reactivated later."
        confirmLabel="Deactivate"
        busy={bulk.isPending}
        error={bulk.error?.message}
        onClose={() => {
          setDeactivating(false);
          bulk.reset();
        }}
        onConfirm={(reason) => bulk.mutate({ action: 'deactivate', reason })}
      />

      <Modal
        open={!!result}
        onClose={() => setResult(null)}
        title={result ? `${result.succeeded} updated, ${result.failed} not changed` : ''}
        footer={
          <button className="btn-primary" onClick={() => setResult(null)}>
            Done
          </button>
        }
      >
        <ul className="divide-y divide-line rounded-lg border border-line">
          {result?.results.map((r) => (
            <li key={r.sipId} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{r.name ?? 'Unknown'}</span>
                  <SipId id={r.sipId} />
                </div>
                <p className="mt-0.5 text-xs text-ink-3">{r.message}</p>
              </div>
              <Tag tone={r.ok ? 'good' : 'bad'}>{r.ok ? 'Done' : 'Not changed'}</Tag>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
