/**
 * A person's accounts in other systems (e.g. their VICIdial agent user) and the
 * figures those systems report about them (e.g. monthly QA score).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { month } from '../../lib/format';
import { Card, CardHead, Field, FormError, ICON, Modal, toast } from '../../components/ui';

type Link = { system: string; externalId: string; context: string };
type Metric = { id: number; source: string; metric: string; period: string; value: number; unit: string | null };

const SYSTEMS: Record<string, string> = { vicidial: 'VICIdial' };
const sys = (s: string) => SYSTEMS[s] ?? s;
const metricLabel = (m: string) => (m === 'qa_score' ? 'QA score' : m.charAt(0).toUpperCase() + m.slice(1).replace(/_/g, ' '));

function fmt(m: Metric): string {
  const v = Number.isInteger(m.value) ? String(m.value) : m.value.toFixed(1);
  return m.unit === '%' ? `${v}%` : m.unit ? `${v} ${m.unit}` : v;
}

export function ConnectedAccounts({ sipId }: { sipId: string }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const key = ['connect', 'employee', sipId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ links: Link[]; metrics: Metric[] }>(`/connect/employees/${sipId}`) });
  const [adding, setAdding] = useState(false);
  const unlink = useMutation({
    mutationFn: (l: Link) => api(`/connect/${l.system}/links`, { method: 'DELETE', body: { externalId: l.externalId, context: l.context } }),
    onSuccess: () => {
      toast('Account unlinked');
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const manage = can('employees.manage');
  const links = q.data?.links ?? [];
  const metrics = q.data?.metrics ?? [];
  // latest period per (source, metric), plus the one before for comparison
  const series = new Map<string, Metric[]>();
  for (const m of metrics) series.set(`${m.source}:${m.metric}`, [...(series.get(`${m.source}:${m.metric}`) ?? []), m]);

  return (
    <>
      <Card>
        <CardHead
          title="Connected accounts"
          meta={links.length ? undefined : 'Not linked to any other system yet'}
          actions={
            manage && (
              <button className="btn-ghost btn-sm" onClick={() => setAdding(true)}>
                <Plus {...ICON} className="text-ink-3" /> Link
              </button>
            )
          }
        />
        {links.length > 0 && (
          <ul className="divide-y divide-line border-t border-line">
            {links.map((l) => (
              <li key={`${l.system}:${l.context}:${l.externalId}`} className="flex items-center gap-2 px-5 py-2.5">
                <span className="text-xs text-ink-3">{sys(l.system)}</span>
                <span className="num text-sm">{l.externalId}</span>
                {l.context && <span className="text-xs text-ink-3">on {l.context}</span>}
                {manage && (
                  <button className="icon-btn ml-auto h-7 w-7" onClick={() => unlink.mutate(l)} aria-label={`Unlink ${l.externalId}`} title="Unlink">
                    <X size={14} strokeWidth={1.5} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {series.size > 0 && (
        <Card>
          <CardHead title="From other systems" meta="Latest figures reported" />
          <ul className="divide-y divide-line border-t border-line">
            {[...series.entries()].map(([k, list]) => {
              const [latest, previous] = list;
              const diff = previous ? latest.value - previous.value : null;
              return (
                <li key={k} className="flex items-baseline gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{metricLabel(latest.metric)}</p>
                    <p className="text-xs text-ink-3">
                      {sys(latest.source)}, {latest.period.length === 7 ? month(latest.period) : latest.period}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="num text-sm">{fmt(latest)}</p>
                    {diff !== null && (
                      <p className="num text-xs text-ink-3">
                        {diff >= 0 ? '+' : ''}
                        {Number.isInteger(diff) ? diff : diff.toFixed(1)} vs {previous.period.length === 7 ? month(previous.period).split(' ')[0] : previous.period}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {adding && <LinkModal sipId={sipId} onClose={() => setAdding(false)} onDone={() => void qc.invalidateQueries({ queryKey: key })} />}
    </>
  );
}

function LinkModal({ sipId, onClose, onDone }: { sipId: string; onClose: () => void; onDone: () => void }) {
  const [system, setSystem] = useState('vicidial');
  const [externalId, setExternalId] = useState('');
  const [context, setContext] = useState('');
  const m = useMutation({
    mutationFn: () => api<{ saved: number; results: Array<{ ok: boolean; message?: string }> }>(`/connect/${system}/links`, {
      method: 'PUT',
      body: { links: [{ sipId, externalId: externalId.trim(), context: context.trim() }] },
    }),
    onSuccess: (r) => {
      if (!r.saved) throw new Error(r.results[0]?.message ?? 'Not linked');
      toast(`Linked ${sys(system)} account ${externalId.trim()}`);
      onDone();
      onClose();
    },
  });
  return (
    <Modal
      open
      title="Link an account"
      description="The user name this person has in another system"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!externalId.trim() || m.isPending} onClick={() => m.mutate()}>
            Link
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={m.error?.message} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="System">
            <select className="input" value={system} onChange={(e) => setSystem(e.target.value)}>
              <option value="vicidial">VICIdial</option>
            </select>
          </Field>
          <Field label="User name" hint="e.g. the VICIdial agent user">
            <input className="input num" value={externalId} onChange={(e) => setExternalId(e.target.value)} />
          </Field>
        </div>
        <Field label="Dialer" hint="Only when the same user name exists on more than one dialer; otherwise leave empty">
          <input className="input" value={context} onChange={(e) => setContext(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
