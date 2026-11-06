/**
 * Connecting the VICIdial QA platform: a key with the right permissions, the
 * agent ↔ employee mapping (paste the agent list, review name matches, save),
 * and the links that exist today.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, ErrorState, Field, FormError, ICON, Loading, SearchInput, SipId, toast, useDebounced } from '../../components/ui';

type Person = { sipId: string; name: string; status: string; department: string | null; designation: string | null; accounts: Array<{ externalId: string; context: string }> };
type Suggestion = { sipId: string; name: string; department: string | null; score: number; alreadyLinked: boolean };
type Row = { externalId: string; context: string; fullName: string; linkedTo: string | null; suggestions: Suggestion[] };

const SCOPES = ['employees.view', 'leave.view', 'metrics.write', 'sales.write'];
const EVENTS = ['employee.created', 'employee.updated', 'employee.activated', 'employee.deactivated', 'employee.reactivated', 'leave_application.approved', 'leave_application.cancelled'];

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="num overflow-x-auto rounded-xl border border-line bg-bg p-4 pr-24 text-xs leading-5">{text}</pre>
      <button
        className="btn-secondary btn-sm absolute right-2 top-2"
        onClick={async () => {
          await navigator.clipboard.writeText(text).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check {...ICON} className="text-good" /> : <Copy {...ICON} className="text-ink-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function VicidialConnect() {
  return (
    <div className="space-y-6">
      <KeyStep />
      <MapStep />
      <Linked />
    </div>
  );
}

/* 1. key ----------------------------------------------------------- */

function KeyStep() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [made, setMade] = useState<string | null>(null);
  const [hookUrl, setHookUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const grantable = SCOPES.filter((s) => can(s as never));
  const key = useMutation({
    mutationFn: () =>
      api<{ key: string }>('/integrations/keys', { method: 'POST', body: { name: 'VICIdial QA platform', scopes: grantable, expiresInDays: 365 } }),
    onSuccess: (r) => {
      setMade(r.key);
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
  const hook = useMutation({
    mutationFn: () => api<{ secret: string }>('/integrations/webhooks', { method: 'POST', body: { name: 'VICIdial QA platform', url: hookUrl.trim(), events: EVENTS } }),
    onSuccess: (r) => {
      setSecret(r.secret);
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
  const origin = window.location.origin;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <p className="card-title">1. Give VICIdial a key</p>
          <p className="text-xs text-ink-3">
            Reads people and leave, and reports QA scores and sales back: <span className="num">{SCOPES.join(', ')}</span>
          </p>
        </div>
        {!made && (
          <button className="btn-primary btn-sm" disabled={key.isPending || grantable.length < SCOPES.length} onClick={() => key.mutate()}>
            Create the VICIdial key
          </button>
        )}
      </div>
      <div className="space-y-4 border-t border-line px-5 py-4">
        <FormError message={key.error?.message} />
        {grantable.length < SCOPES.length && <p className="text-sm text-warn">You need {SCOPES.join(', ')} yourself to create this key.</p>}
        {made ? (
          <>
            <p className="text-sm text-ink-2">
              Add these two lines to the VICIdial project's <span className="num">.env</span>, then follow the kit in <span className="num">integrations/vicidial</span>. The key is
              shown once.
            </p>
            <CopyBlock text={`HRMS_URL=${origin}\nHRMS_API_KEY=${made}`} />
          </>
        ) : (
          <p className="text-sm text-ink-2">
            The key is shown once, with the lines to paste into VICIdial's <span className="num">.env</span>.
          </p>
        )}
        <div className="border-t border-line pt-4">
          <p className="text-sm">Optional: tell VICIdial at once when someone leaves, returns or goes on leave</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="VICIdial webhook URL" className="min-w-[320px] flex-1">
              <input className="input num" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://qa.example.com/api/v1/hrms/webhook/<qa company slug>" />
            </Field>
            <button className="btn-secondary" disabled={!/^https?:\/\/.+/.test(hookUrl.trim()) || hook.isPending || !!secret} onClick={() => hook.mutate()}>
              <Link2 {...ICON} className="text-ink-3" /> Add webhook
            </button>
          </div>
          <FormError message={hook.error?.message} />
          {secret && (
            <div className="mt-3">
              <CopyBlock text={`HRMS_WEBHOOK_SECRET=${secret}`} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* 2. mapping --------------------------------------------------------- */

function parse(text: string): Array<{ externalId: string; fullName: string; context: string }> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(user|vici_?user|agent)\b/i.test(l))
    .map((l) => {
      const [externalId = '', fullName = '', context = ''] = l.split(/\t|,|;/).map((s) => s.trim());
      return { externalId, fullName, context };
    })
    .filter((r) => r.externalId);
}

function MapStep() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const roster = useQuery({ queryKey: ['connect', 'vicidial', 'roster'], queryFn: () => api<{ data: Person[] }>('/connect/vicidial/roster') });
  const parsed = useMemo(() => parse(text), [text]);

  const suggest = useMutation({
    mutationFn: () => api<{ data: Row[] }>('/connect/vicidial/suggest', { method: 'POST', body: { accounts: parsed } }),
    onSuccess: (r) => {
      setRows(r.data);
      // pre-pick confident matches; anything uncertain is left for a person to choose
      const pre: Record<string, string> = {};
      for (const x of r.data) {
        const best = x.suggestions[0];
        if (!x.linkedTo && best && best.score >= 0.75 && !best.alreadyLinked && (x.suggestions[1]?.score ?? 0) < best.score) pre[k(x)] = best.sipId;
      }
      setChoice(pre);
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api<{ saved: number; failed: number }>('/connect/vicidial/links', {
        method: 'PUT',
        body: {
          links: Object.entries(choice)
            .filter(([, sip]) => sip)
            .map(([key, sipId]) => {
              const [context, externalId] = key.split('\u0000');
              return { sipId, externalId, context };
            }),
        },
      }),
    onSuccess: (r) => {
      toast(`${r.saved} agents linked${r.failed ? `, ${r.failed} failed` : ''}`);
      setRows(null);
      setText('');
      void qc.invalidateQueries({ queryKey: ['connect'] });
    },
  });
  const k = (r: { context: string; externalId: string }) => `${r.context}\u0000${r.externalId}`;
  const picked = Object.values(choice).filter(Boolean).length;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <p className="card-title">2. Match VICIdial agents to employees</p>
          <p className="text-xs text-ink-3">Paste one agent per line: user, full name and, only if you run several dialers, the dialer name</p>
        </div>
      </div>
      <div className="space-y-4 border-t border-line px-5 py-4">
        {!rows ? (
          <>
            <textarea
              className="input num min-h-[140px]"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'agent1043, Hira Qureshi\nagent1044, Usman Tariq\nagent2001, Sana Javed, Dialer B'}
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-ink-3">{parsed.length ? `${parsed.length} agents read` : 'Copy them from VICIdial QA → Admin → Agents, or a CSV export'}</p>
              <button className="btn-primary btn-sm" disabled={!parsed.length || suggest.isPending} onClick={() => suggest.mutate()}>
                Find matches
              </button>
            </div>
            <FormError message={suggest.error?.message} />
          </>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="table">
                <thead>
                  <tr>
                    <th className="th">VICIdial agent</th>
                    <th className="th">Employee</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={k(r)}>
                      <td className="td">
                        <p className="num text-sm">{r.externalId}</p>
                        <p className="text-xs text-ink-3">
                          {r.fullName || 'No name given'}
                          {r.context && `, ${r.context}`}
                        </p>
                      </td>
                      <td className="td">
                        {r.linkedTo ? (
                          <span className="flex items-center gap-2 text-sm text-ink-2">
                            Already linked <SipId id={r.linkedTo} to={`/employees/${r.linkedTo}`} />
                          </span>
                        ) : (
                          <select className="input max-w-md" value={choice[k(r)] ?? ''} onChange={(e) => setChoice({ ...choice, [k(r)]: e.target.value })}>
                            <option value="">Don't link</option>
                            {r.suggestions.length > 0 && (
                              <optgroup label="Name matches">
                                {r.suggestions.map((s) => (
                                  <option key={s.sipId} value={s.sipId}>
                                    {s.name} ({s.sipId}) {Math.round(s.score * 100)}%{s.alreadyLinked ? ', has another account' : ''}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            <optgroup label="Everyone">
                              {(roster.data?.data ?? []).map((p) => (
                                <option key={p.sipId} value={p.sipId}>
                                  {p.name} ({p.sipId}){p.department ? `, ${p.department}` : ''}
                                </option>
                              ))}
                            </optgroup>
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <FormError message={save.error?.message} />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-ink-3">Strong name matches are picked for you. Check them, then save</p>
              <div className="flex gap-2">
                <button className="btn-secondary btn-sm" onClick={() => setRows(null)}>
                  Back
                </button>
                <button className="btn-primary btn-sm" disabled={!picked || save.isPending} onClick={() => save.mutate()}>
                  Link {picked} {picked === 1 ? 'agent' : 'agents'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* 3. current links ----------------------------------------------------- */

function Linked() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const term = useDebounced(search).toLowerCase();
  const q = useQuery({ queryKey: ['connect', 'vicidial', 'roster', 'all'], queryFn: () => api<{ data: Person[]; linked: number }>('/connect/vicidial/roster', { query: { status: 'all' } }) });
  const unlink = useMutation({
    mutationFn: (a: { externalId: string; context: string }) => api('/connect/vicidial/links', { method: 'DELETE', body: a }),
    onSuccess: () => {
      toast('Unlinked');
      void qc.invalidateQueries({ queryKey: ['connect'] });
    },
  });
  const linked = (q.data?.data ?? []).filter((p) => p.accounts.length > 0);
  const shown = linked.filter((p) => !term || p.name.toLowerCase().includes(term) || p.sipId.includes(term) || p.accounts.some((a) => a.externalId.toLowerCase().includes(term)));
  const active = (q.data?.data ?? []).filter((p) => p.status === 'active');
  const unlinkedActive = active.filter((p) => p.accounts.length === 0).length;

  return (
    <div className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="card-title">3. Linked agents</p>
          <p className="text-xs text-ink-3">
            {linked.length} linked, {unlinkedActive} active {unlinkedActive === 1 ? 'employee has' : 'employees have'} no VICIdial account
          </p>
        </div>
        <SearchInput value={search} onChange={setSearch} placeholder="Agent, name or SIP ID" className="w-60" />
      </div>
      {q.isLoading ? (
        <Loading inline />
      ) : q.error ? (
        <ErrorState message={q.error.message} />
      ) : shown.length === 0 ? (
        <EmptyState bare title={linked.length ? 'No match' : 'No agents linked yet'} hint={linked.length ? 'Try another name' : 'Paste the agent list above to link them in one go'} />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {shown.map((p) => (
            <li key={p.sipId} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span className="min-w-[200px] text-sm">{p.name}</span>
              <SipId id={p.sipId} to={`/employees/${p.sipId}`} />
              <span className="text-xs text-ink-3">{p.department ?? ''}</span>
              <span className="ml-auto flex flex-wrap gap-1.5">
                {p.accounts.map((a) => (
                  <span key={`${a.context}:${a.externalId}`} className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-raised pl-2 text-xs">
                    <span className="num">{a.externalId}</span>
                    {a.context && <span className="text-ink-3">on {a.context}</span>}
                    <button className="grid h-7 w-6 place-items-center text-ink-3 hover:text-bad" onClick={() => unlink.mutate(a)} aria-label={`Unlink ${a.externalId}`}>
                      <X size={12} strokeWidth={1.5} />
                    </button>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
