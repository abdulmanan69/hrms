import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import {
  Card,
  CardHead,
  EmptyState,
  ErrorState,
  ICON,
  Loading,
  PageHeader,
  Pagination,
  SearchInput,
  SipId,
  StatusTag,
  useDebounced,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { date, dateTime, fileSize } from '../../lib/format';
import { DOCUMENT_LABELS, DOCUMENT_TYPES, empKeys, employeesApi, type BlockedEmployee } from '../../api/employees';
import { UploadDocumentModal } from './parts';
import { statusText } from './Employees';

export function Documents() {
  return (
    <div className="rise">
      <PageHeader title="Documents" subtitle="CNIC copies, contracts and letters on employee records" />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-1">
          <Blocked />
        </div>
        <div className="xl:col-span-2">
          <AllDocuments />
        </div>
      </div>
    </div>
  );
}

function Blocked() {
  const { can } = useAuth();
  const canUpload = can('documents.manage', 'employees.manage');
  const q = useQuery({ queryKey: empKeys.blocked, queryFn: employeesApi.blocked });
  const [target, setTarget] = useState<BlockedEmployee | null>(null);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const rows = q.data?.data ?? [];
  const waiting = rows.filter((r) => !r.ready);
  const ready = rows.filter((r) => r.ready);

  return (
    <Card>
      <CardHead title="Can't go active yet" meta="New hires missing required documents" actions={<span className="num text-xs text-ink-3">{waiting.length}</span>} />
      {rows.length === 0 ? (
        <EmptyState bare title="Nobody is waiting" hint="New hires appear here until their CNIC copy and signed contract are uploaded" />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {waiting.map((b) => (
            <li key={b.sipId} className="flex items-center gap-3 px-5 py-3">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link to={`/employees/${b.sipId}`} className="truncate text-sm font-medium transition-colors hover:text-brand">
                    {b.name}
                  </Link>
                  <SipId id={b.sipId} />
                </div>
                <p className="mt-0.5 text-xs text-ink-3">
                  Missing {b.missing.join(', ')} · joins {date(b.dateOfJoining, true)}
                </p>
              </div>
              {canUpload && b.missingTypes.length > 0 ? (
                <button className="btn-secondary btn-sm shrink-0" onClick={() => setTarget(b)}>
                  Upload
                </button>
              ) : (
                <Link to={`/employees/${b.sipId}`} className="btn-secondary btn-sm shrink-0">
                  Open
                </Link>
              )}
            </li>
          ))}
          {ready.map((b) => (
            <li key={b.sipId} className="flex items-center gap-3 px-5 py-3">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-good" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{b.name}</span>
                  <SipId id={b.sipId} />
                </div>
                <p className="mt-0.5 text-xs text-ink-3">Documents complete, ready to activate</p>
              </div>
              <Link to={`/employees/${b.sipId}`} className="btn-secondary btn-sm shrink-0">
                Review
              </Link>
            </li>
          ))}
        </ul>
      )}
      {target && (
        <UploadDocumentModal
          open
          onClose={() => setTarget(null)}
          sipId={target.sipId}
          employeeName={target.name}
          defaultType={target.missingTypes[0] ?? 'other'}
        />
      )}
    </Card>
  );
}

function AllDocuments() {
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search);
  const query = { type: type || undefined, search: term || undefined, page };
  const q = useQuery({ queryKey: empKeys.documents(query), queryFn: () => employeesApi.documents(query), placeholderData: keepPreviousData });
  const rows = q.data?.data ?? [];
  const filtered = !!(type || term);

  return (
    <Card className="overflow-hidden">
      <CardHead
        title="All documents"
        meta="Newest first"
        actions={
          <>
            <SearchInput
              className="w-56"
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder="Employee, SIP ID or file"
            />
            <select
              className="input w-40"
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setPage(1);
              }}
              aria-label="Document type"
            >
              <option value="">All types</option>
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_LABELS[t]}
                </option>
              ))}
            </select>
          </>
        }
      />
      {q.isLoading ? (
        <div className="p-6">
          <Loading inline />
        </div>
      ) : q.error ? (
        <div className="p-5">
          <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          bare
          title={filtered ? 'No documents match' : 'No documents yet'}
          hint={filtered ? 'Try another type or name' : 'Upload documents from an employee profile or from the list on the left'}
          illustration={filtered ? undefined : 'documents.empty'}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="table [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_td]:px-3 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5 [&_th]:px-3">
            <thead>
              <tr>
                <th className="th">Employee</th>
                <th className="th">Document</th>
                <th className="th text-right">Size</th>
                <th className="th">Uploaded</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="td">
                    <div className="flex items-center gap-2">
                      <Link to={`/employees/${d.sipId}`} className="font-medium transition-colors hover:text-brand">
                        {d.employeeName}
                      </Link>
                      <SipId id={d.sipId} />
                    </div>
                    {d.employeeStatus !== 'active' && (
                      <div className="mt-1">
                        <StatusTag value={d.employeeStatus} text={statusText(d.employeeStatus)} />
                      </div>
                    )}
                  </td>
                  <td className="td max-w-[220px]">
                    <p>{DOCUMENT_LABELS[d.type]}</p>
                    <a
                      href={employeesApi.documentUrl(d.sipId, d.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-xs text-ink-3 transition-colors hover:text-brand"
                      title={d.fileName}
                    >
                      {d.fileName}
                    </a>
                  </td>
                  <td className="td num text-right text-ink-2">{fileSize(d.sizeBytes)}</td>
                  <td className="td text-ink-2">
                    {dateTime(d.uploadedAt)}
                    {d.uploadedByName && <p className="text-xs text-ink-3">{d.uploadedByName}</p>}
                  </td>
                  <td className="td text-right">
                    <a className="icon-btn ml-auto" href={employeesApi.documentUrl(d.sipId, d.id, true)} aria-label={`Download ${d.fileName}`} title="Download">
                      <Download {...ICON} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data && <Pagination meta={q.data.meta} onPage={setPage} />}
    </Card>
  );
}
