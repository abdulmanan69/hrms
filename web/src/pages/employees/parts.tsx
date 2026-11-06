/** Pieces shared by the employee pages: documents, uploads, status modals, history. */
import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Trash2, Upload } from 'lucide-react';
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  ICON,
  Loading,
  Modal,
  Pagination,
  Tag,
  toast,
} from '../../components/ui';
import { dateTime, fileSize, label } from '../../lib/format';
import {
  DOCUMENT_LABELS,
  DOCUMENT_TYPES,
  empKeys,
  employeesApi,
  type DocumentType,
  type EmployeeDocument,
  type HistoryRow,
} from '../../api/employees';

/** Refresh every employee query and the sidebar counts. */
export function useInvalidateEmployees() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: empKeys.all });
    void qc.invalidateQueries({ queryKey: ['nav-counts'] });
  };
}

/* ------------------------------------------------------------------ */
/* Upload                                                               */
/* ------------------------------------------------------------------ */

export function UploadDocumentModal({
  open,
  onClose,
  sipId,
  employeeName,
  defaultType = 'cnic',
}: {
  open: boolean;
  onClose: () => void;
  sipId: string;
  employeeName: string;
  defaultType?: DocumentType;
}) {
  const invalidate = useInvalidateEmployees();
  const [type, setType] = useState<DocumentType>(defaultType);
  const [file, setFile] = useState<File | null>(null);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setType(defaultType);
      setFile(null);
    }
  }
  const m = useMutation({
    mutationFn: () => employeesApi.uploadDocument(sipId, type, file as File),
    onSuccess: (res) => {
      invalidate();
      toast(
        res.blockers.length === 0
          ? `${DOCUMENT_LABELS[type]} uploaded`
          : `${DOCUMENT_LABELS[type]} uploaded. Still missing: ${res.blockers.join(', ')}`,
      );
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Upload a document for ${employeeName}`}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!file || m.isPending} onClick={() => m.mutate()}>
            <Upload {...ICON} />
            Upload
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Type" required>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as DocumentType)}>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOCUMENT_LABELS[t]}
                {t === 'cnic' || t === 'contract' ? ' (required)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="File" required hint="PDF, image or Word document">
          <input
            type="file"
            className="input py-1.5"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <FormError message={m.error?.message} />
      </div>
    </Modal>
  );
}

/** One-click upload of a known type: opens the file picker directly. */
export function QuickUploadButton({ sipId, type, children }: { sipId: string; type: DocumentType; children: ReactNode }) {
  const invalidate = useInvalidateEmployees();
  const input = useRef<HTMLInputElement>(null);
  const m = useMutation({
    mutationFn: (file: File) => employeesApi.uploadDocument(sipId, type, file),
    onSuccess: (res) => {
      invalidate();
      toast(res.blockers.length === 0 ? `${DOCUMENT_LABELS[type]} uploaded. Ready to activate` : `${DOCUMENT_LABELS[type]} uploaded`);
    },
    onError: (err) => toast(err.message, 'bad'),
  });
  return (
    <>
      <input
        ref={input}
        type="file"
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) m.mutate(f);
          e.target.value = '';
        }}
      />
      <button className="btn-secondary btn-sm" disabled={m.isPending} onClick={() => input.current?.click()}>
        <Upload {...ICON} className="text-ink-3" />
        {children}
      </button>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Document list                                                        */
/* ------------------------------------------------------------------ */

export function DocumentList({
  sipId,
  documents,
  required,
  canManage,
  employeeActive,
}: {
  sipId: string;
  documents: EmployeeDocument[];
  required: DocumentType[];
  canManage: boolean;
  employeeActive?: boolean;
}) {
  const invalidate = useInvalidateEmployees();
  const [removing, setRemoving] = useState<EmployeeDocument | null>(null);
  const del = useMutation({
    mutationFn: (d: EmployeeDocument) => employeesApi.deleteDocument(sipId, d.id),
    onSuccess: () => {
      invalidate();
      toast('Document removed');
      setRemoving(null);
    },
  });
  const have = new Set(documents.map((d) => d.type));
  const missingRequired = required.filter((t) => !have.has(t));

  return (
    <>
      {missingRequired.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {missingRequired.map((t) => (
            <li key={t} className="flex items-center gap-3 px-5 py-3">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-dashed border-line text-ink-3">
                <FileText {...ICON} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{DOCUMENT_LABELS[t]}</p>
                <p className="text-xs text-ink-3">Required before the record can go active</p>
              </div>
              <Tag tone="warn">Missing</Tag>
              {canManage && (
                <QuickUploadButton sipId={sipId} type={t}>
                  Upload
                </QuickUploadButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {documents.length === 0 && missingRequired.length === 0 ? (
        <EmptyState bare title="No documents yet" hint={canManage ? 'Uploaded CNIC copies, contracts and letters appear here' : 'HR uploads your documents here'} />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-5 py-3">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-raised text-ink-3">
                <FileText {...ICON} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a
                    href={employeesApi.documentUrl(sipId, d.id)}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-sm font-medium transition-colors hover:text-brand"
                  >
                    {d.fileName}
                  </a>
                  {required.includes(d.type) && <span className="text-xs text-ink-3">required</span>}
                </div>
                <p className="mt-0.5 text-xs text-ink-3">
                  {DOCUMENT_LABELS[d.type]} · <span className="num">{fileSize(d.sizeBytes)}</span> · {dateTime(d.uploadedAt)}
                  {d.uploadedByName ? ` by ${d.uploadedByName}` : ''}
                </p>
              </div>
              <a className="icon-btn" href={employeesApi.documentUrl(sipId, d.id, true)} aria-label={`Download ${d.fileName}`} title="Download">
                <Download {...ICON} />
              </a>
              {canManage && (
                <button className="icon-btn hover:bg-bad-soft hover:text-bad" onClick={() => setRemoving(d)} aria-label={`Remove ${d.fileName}`} title="Remove">
                  <Trash2 {...ICON} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmModal
        open={!!removing}
        title="Remove document"
        confirmLabel="Remove"
        danger
        busy={del.isPending}
        onClose={() => {
          setRemoving(null);
          del.reset();
        }}
        onConfirm={() => removing && del.mutate(removing)}
        body={
          <>
            {removing?.fileName} is hidden from the record but kept for the audit trail.
            {employeeActive && removing && required.includes(removing.type) && ' Upload a replacement first if this is the only copy.'}
          </>
        }
      >
        <div className="mt-3">
          <FormError message={del.error?.message} />
        </div>
      </ConfirmModal>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Deactivate                                                           */
/* ------------------------------------------------------------------ */

export function ReasonModal({
  open,
  title,
  body,
  confirmLabel,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const close = () => {
    setReason('');
    onClose();
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={close}
      footer={
        <>
          <button className="btn-secondary" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn-danger" disabled={busy || reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm text-ink-2">{body}</div>
      <div className="mt-4 space-y-3">
        <Field label="Reason" required hint="Kept in the history, e.g. resigned, contract ended">
          <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <FormError message={error} />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* History                                                              */
/* ------------------------------------------------------------------ */

const LOOKUP_KEYS = new Set(['departmentId', 'designationId']);

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'empty';
  return String(v);
}

/** Field-level changes on an update row, e.g. "Phone: 0300… → 0321…". */
function changes(r: HistoryRow): Array<{ field: string; from: string; to: string }> {
  if (!(r.action === 'update' || r.action === 'update_self') || !r.before || !r.after) return [];
  return Object.keys(r.after)
    .filter((k) => !LOOKUP_KEYS.has(k))
    .map((k) => ({ field: label(k.replace(/([A-Z])/g, '_$1').toLowerCase()), from: show(r.before?.[k]), to: show(r.after?.[k]) }));
}

export function HistoryTimeline({ sipId }: { sipId: string }) {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: [...empKeys.history(sipId), page], queryFn: () => employeesApi.history(sipId, page) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const rows = q.data?.data ?? [];
  return (
    <div className="card">
      {rows.length === 0 ? (
        <EmptyState bare title="No history yet" hint="Edits, status changes and document uploads appear here" />
      ) : (
        <ol className="divide-y divide-line">
          {rows.map((r) => {
            const diff = changes(r);
            const reason = (r.after as { reason?: string } | null)?.reason;
            return (
              <li key={r.id} className="flex gap-4 px-5 py-3">
                <span className="num w-28 shrink-0 pt-0.5 text-xs text-ink-3">{dateTime(r.createdAt)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink-2">
                    <span className="text-ink">{r.userName ?? 'System'}</span> {r.summary ?? `${r.action} ${r.entity}`}
                  </p>
                  {diff.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {diff.map((d) => (
                        <li key={d.field} className="text-xs text-ink-3">
                          {d.field}: <span className="text-ink-2">{d.from}</span> to <span className="text-ink-2">{d.to}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {reason && r.action !== 'deactivate' && <p className="mt-1 text-xs text-ink-3">Reason: {reason}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {q.data && <Pagination meta={q.data.meta} onPage={setPage} />}
    </div>
  );
}
