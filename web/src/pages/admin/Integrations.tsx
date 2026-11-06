import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  Send,
  Webhook,
} from "lucide-react";
import { api, type Paged } from "../../lib/api";
import { VicidialConnect } from "./VicidialConnect";
import { useAuth } from "../../lib/auth";
import { dateTime, label as toLabel } from "../../lib/format";
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  ICON,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  Segmented,
  Stat,
  Tabs,
  Tag,
  toast,
} from "../../components/ui";

type Overview = {
  activeKeys: number;
  activeWebhooks: number;
  deliveriesToday: { delivered: number; failed: number; pending: number };
  lastEventId: number;
  liveConnections: number;
  scopes: string[];
  eventCatalog: Array<{ type: string; label: string }>;
};
type ApiKey = {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdByName: string | null;
};
type Hook = {
  id: number;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  stats: {
    delivered: number;
    failed: number;
    pending: number;
    lastAt: string | null;
  };
};
type Delivery = {
  id: number;
  eventType: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string;
  payload: unknown;
};

const KEY = ["integrations"];

export function Integrations() {
  const [tab, setTab] = useState<
    "overview" | "keys" | "webhooks" | "vicidial" | "guide"
  >("overview");
  const ov = useQuery({
    queryKey: [...KEY, "overview"],
    queryFn: () => api<Overview>("/integrations/overview"),
    refetchInterval: 15_000,
  });

  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Integrations"
        subtitle="Connect other apps: they read and send data with an API key, and get told about changes by webhook or a live connection"
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "keys", label: "API keys", count: ov.data?.activeKeys },
          {
            value: "webhooks",
            label: "Webhooks",
            count: ov.data?.activeWebhooks,
          },
          { value: "vicidial", label: "VICIdial" },
          { value: "guide", label: "Developer guide" },
        ]}
      />
      {ov.isLoading ? (
        <Loading />
      ) : ov.error ? (
        <ErrorState message={ov.error.message} onRetry={() => ov.refetch()} />
      ) : (
        <>
          {tab === "overview" && <OverviewTab o={ov.data!} go={setTab} />}
          {tab === "keys" && <KeysTab scopes={ov.data!.scopes} />}
          {tab === "webhooks" && (
            <WebhooksTab catalog={ov.data!.eventCatalog} />
          )}
          {tab === "vicidial" && <VicidialConnect />}
          {tab === "guide" && <Guide catalog={ov.data!.eventCatalog} />}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function OverviewTab({
  o,
  go,
}: {
  o: Overview;
  go: (t: "keys" | "webhooks" | "guide") => void;
}) {
  const d = o.deliveriesToday;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat
          label="Active API keys"
          value={o.activeKeys}
          note="Other apps reading and sending data"
        />
        <Stat
          label="Active webhooks"
          value={o.activeWebhooks}
          note={`${d.pending} deliveries waiting`}
        />
        <Stat
          label="Delivered today"
          value={d.delivered}
          note={
            d.failed ? `${d.failed} failed after every retry` : "No failures"
          }
        />
        <Stat
          label="Live connections"
          value={o.liveConnections}
          note={`Last event #${o.lastEventId}`}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {[
          {
            icon: <KeyRound {...ICON} />,
            title: "Read and send data",
            text: "Give another app an API key with only the permissions it needs. It calls the same endpoints this app uses, limited to this company.",
            action: "Create an API key",
            to: "keys" as const,
          },
          {
            icon: <Webhook {...ICON} />,
            title: "Get told about changes",
            text: "A webhook POSTs a signed JSON message to your app when something happens, like an approved leave or a new hire. Failed sends retry for a day.",
            action: "Add a webhook",
            to: "webhooks" as const,
          },
          {
            icon: <RefreshCw {...ICON} />,
            title: "Stay connected live",
            text: "A WebSocket streams events as they happen and accepts requests on the same connection. Missed events replay from where the app left off.",
            action: "Read the guide",
            to: "guide" as const,
          },
        ].map((c) => (
          <div key={c.title} className="card flex flex-col p-5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-raised text-ink-2">
              {c.icon}
            </span>
            <p className="mt-4 text-sm font-medium">{c.title}</p>
            <p className="mt-1 flex-1 text-sm text-ink-2">{c.text}</p>
            <button
              className="btn-secondary btn-sm mt-4 self-start"
              onClick={() => go(c.to)}
            >
              {c.action}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CopyField({ value, hint }: { value: string; hint: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-bg p-1 pl-3">
        <code className="num min-w-0 flex-1 truncate text-sm">{value}</code>
        <button
          className="btn-secondary btn-sm shrink-0"
          onClick={async () => {
            await navigator.clipboard.writeText(value).catch(() => undefined);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? (
            <Check {...ICON} className="text-good" />
          ) : (
            <Copy {...ICON} className="text-ink-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-2 text-xs text-warn">{hint}</p>
    </div>
  );
}

function KeysTab({ scopes }: { scopes: string[] }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const q = useQuery({
    queryKey: [...KEY, "keys"],
    queryFn: () => api<{ data: ApiKey[] }>("/integrations/keys"),
  });
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<(ApiKey & { key: string }) | null>(
    null,
  );
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const revoke = useMutation({
    mutationFn: (id: number) =>
      api(`/integrations/keys/${id}/revoke`, { method: "POST", body: {} }),
    onSuccess: () => {
      toast("Key revoked. Apps using it are refused from now on");
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });

  return (
    <div className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="card-title">API keys</p>
          <p className="text-xs text-ink-3">
            Send as Authorization: Bearer &lt;key&gt;. Each key works only in
            this company, with only its permissions
          </p>
        </div>
        <button className="btn-primary btn-sm" onClick={() => setAdding(true)}>
          <Plus {...ICON} /> New key
        </button>
      </div>
      {q.isLoading ? (
        <Loading inline />
      ) : q.error ? (
        <ErrorState message={q.error.message} />
      ) : q.data!.data.length === 0 ? (
        <EmptyState
          bare
          title="No API keys yet"
          hint="Create one for each app that connects, so you can revoke them separately"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="th">Name</th>
                <th className="th">Key</th>
                <th className="th">Permissions</th>
                <th className="th">Last used</th>
                <th className="th">Expires</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {q.data!.data.map((k) => (
                <tr key={k.id} className={k.revokedAt ? "opacity-60" : ""}>
                  <td className="td">
                    <p className="font-medium">{k.name}</p>
                    <p className="text-xs text-ink-3">
                      {k.createdByName ?? "Unknown"}, {dateTime(k.createdAt)}
                    </p>
                  </td>
                  <td className="td num text-xs text-ink-2">
                    hrms_{k.prefix}_…
                  </td>
                  <td className="td max-w-[360px] whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <span
                          key={s}
                          className="num rounded border border-line bg-raised px-1.5 text-xs text-ink-2"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="td text-ink-2">
                    {k.lastUsedAt ? dateTime(k.lastUsedAt) : "Never"}
                  </td>
                  <td className="td text-ink-2">
                    {k.revokedAt ? (
                      <Tag>Revoked</Tag>
                    ) : k.expiresAt ? (
                      dateTime(k.expiresAt)
                    ) : (
                      "Never"
                    )}
                  </td>
                  <td className="td text-right">
                    {!k.revokedAt && (
                      <>
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() => setEditingKey(k)}
                        >
                          Edit
                        </button>
                        <button
                          className="btn-ghost btn-sm text-bad hover:bg-bad-soft hover:text-bad"
                          onClick={() => setRevoking(k)}
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <NewKey
          scopes={scopes.filter((s) => can(s as never))}
          onClose={() => setAdding(false)}
          onCreated={(k) => {
            setAdding(false);
            setCreated(k);
            void qc.invalidateQueries({ queryKey: KEY });
          }}
        />
      )}
      {editingKey && (
        <NewKey
          scopes={scopes.filter(
            (s) => can(s as never) || editingKey.scopes.includes(s),
          )}
          editing={editingKey}
          onClose={() => setEditingKey(null)}
          onCreated={() => {
            setEditingKey(null);
            toast("Key updated. The app keeps the same key");
            void qc.invalidateQueries({ queryKey: KEY });
          }}
        />
      )}
      <Modal
        open={!!created}
        title={`Key for ${created?.name ?? ""}`}
        onClose={() => setCreated(null)}
        footer={
          <button className="btn-primary" onClick={() => setCreated(null)}>
            Done
          </button>
        }
      >
        {created && (
          <CopyField
            value={created.key}
            hint="Copy it now and store it in the other app's secrets. It won't be shown again"
          />
        )}
      </Modal>
      <ConfirmModal
        open={!!revoking}
        title={`Revoke "${revoking?.name}"`}
        body="Apps using this key stop working at once, including open live connections. This can't be undone; create a new key instead."
        confirmLabel="Revoke key"
        danger
        busy={revoke.isPending}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </div>
  );
}

function NewKey({
  scopes,
  editing,
  onClose,
  onCreated,
}: {
  scopes: string[];
  /** change this key's name and permissions instead of creating one */
  editing?: ApiKey;
  onClose: () => void;
  onCreated: (k: ApiKey & { key: string }) => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [picked, setPicked] = useState<string[]>(
    editing?.scopes ?? ["employees.view"],
  );
  const [expiry, setExpiry] = useState<"never" | "90" | "365">("365");
  const m = useMutation({
    mutationFn: () =>
      editing
        ? api<ApiKey & { key: string }>(`/integrations/keys/${editing.id}`, {
            method: "PATCH",
            body: { name, scopes: picked },
          })
        : api<ApiKey & { key: string }>("/integrations/keys", {
            method: "POST",
            body: {
              name,
              scopes: picked,
              expiresInDays: expiry === "never" ? null : Number(expiry),
            },
          }),
    onSuccess: onCreated,
  });
  const groups = [...new Set(scopes.map((s) => s.split(".")[0]))];
  return (
    <Modal
      open
      wide
      title={editing ? `Edit "${editing.name}"` : "New API key"}
      description={
        editing
          ? "The app keeps using the same key; only what it may do changes"
          : "Give it only what the other app needs. You can change its permissions later"
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={
              name.trim().length < 2 || picked.length === 0 || m.isPending
            }
            onClick={() => m.mutate()}
          >
            {editing ? "Save" : "Create key"}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={m.error?.message} />
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field
            label="Name"
            hint="Which app uses it, e.g. Attendance device sync"
          >
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {!editing && (
            <Field label="Expires">
              <Segmented
                value={expiry}
                onChange={setExpiry}
                options={[
                  { value: "90", label: "90 days" },
                  { value: "365", label: "1 year" },
                  { value: "never", label: "Never" },
                ]}
              />
            </Field>
          )}
        </div>
        <div>
          <p className="mb-2 text-sm text-ink-2">Permissions</p>
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
            {groups.map((g) => (
              <div key={g}>
                <p className="mb-1 text-xs text-ink-3">{toLabel(g)}</p>
                {scopes
                  .filter((s) => s.startsWith(`${g}.`))
                  .map((s) => (
                    <label
                      key={s}
                      className="flex cursor-pointer items-center gap-2 py-1 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[#3B4A9F]"
                        checked={picked.includes(s)}
                        onChange={(e) =>
                          setPicked(
                            e.target.checked
                              ? [...picked, s]
                              : picked.filter((x) => x !== s),
                          )
                        }
                      />
                      <span className="num text-xs">{s}</span>
                    </label>
                  ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function WebhooksTab({ catalog }: { catalog: Overview["eventCatalog"] }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [...KEY, "webhooks"],
    queryFn: () => api<{ data: Hook[] }>("/integrations/webhooks"),
    refetchInterval: 15_000,
  });
  const [editing, setEditing] = useState<Hook | "new" | null>(null);
  const [viewing, setViewing] = useState<Hook | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(
    null,
  );

  const test = useMutation({
    mutationFn: (id: number) =>
      api<{
        ok: boolean;
        status: number | null;
        error: string | null;
        ms: number;
      }>(`/integrations/webhooks/${id}/test`, { method: "POST", body: {} }),
    onSuccess: (r) =>
      toast(
        r.ok
          ? `Receiver answered ${r.status} in ${r.ms} ms`
          : (r.error ?? "Test failed"),
        r.ok ? "good" : "bad",
      ),
    onError: (e) => toast(e.message, "bad"),
  });

  return (
    <div className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="card-title">Webhooks</p>
          <p className="text-xs text-ink-3">
            Signed POST requests to your app when something happens. Failed
            sends retry with growing pauses for about a day
          </p>
        </div>
        <button
          className="btn-primary btn-sm"
          onClick={() => setEditing("new")}
        >
          <Plus {...ICON} /> New webhook
        </button>
      </div>
      {q.isLoading ? (
        <Loading inline />
      ) : q.error ? (
        <ErrorState message={q.error.message} />
      ) : q.data!.data.length === 0 ? (
        <EmptyState
          bare
          title="No webhooks yet"
          hint="Add one to tell another app about new hires, approved leave or paid payroll"
        />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {q.data!.data.map((h) => (
            <li
              key={h.id}
              className="flex flex-wrap items-center gap-4 px-5 py-4"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${!h.active ? "bg-ink/20" : h.stats.failed > 0 ? "bg-warn" : "bg-good"}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  {h.name}
                  {!h.active && <Tag>Off</Tag>}
                </p>
                <p className="num truncate text-xs text-ink-3">{h.url}</p>
                <p className="mt-1 text-xs text-ink-3">{h.events.join(", ")}</p>
              </div>
              <p className="num text-xs text-ink-3">
                {h.stats.delivered} sent
                {h.stats.failed ? `, ${h.stats.failed} failed` : ""}
                {h.stats.pending ? `, ${h.stats.pending} waiting` : ""}
              </p>
              <div className="flex gap-1">
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => test.mutate(h.id)}
                  disabled={test.isPending}
                >
                  <Send {...ICON} className="text-ink-3" /> Test
                </button>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setViewing(h)}
                >
                  Deliveries
                </button>
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => setEditing(h)}
                >
                  Edit
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <HookForm
          hook={editing === "new" ? null : editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            setEditing(null);
            if (s) setSecret(s);
            void qc.invalidateQueries({ queryKey: KEY });
          }}
        />
      )}
      {viewing && (
        <Deliveries hook={viewing} onClose={() => setViewing(null)} />
      )}
      <Modal
        open={!!secret}
        title={`Signing secret for ${secret?.name ?? ""}`}
        onClose={() => setSecret(null)}
        footer={
          <button className="btn-primary" onClick={() => setSecret(null)}>
            Done
          </button>
        }
      >
        {secret && (
          <div className="space-y-3">
            <CopyField
              value={secret.secret}
              hint="Store it in the receiving app. It won't be shown again"
            />
            <p className="text-sm text-ink-2">
              Your app checks each request: HMAC-SHA256 of{" "}
              <code className="num text-xs">timestamp + "." + body</code> with
              this secret must equal the{" "}
              <code className="num text-xs">X-HRMS-Signature</code> header. See
              the developer guide for code.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}

function HookForm({
  hook,
  catalog,
  onClose,
  onSaved,
}: {
  hook: Hook | null;
  catalog: Overview["eventCatalog"];
  onClose: () => void;
  onSaved: (secret: { name: string; secret: string } | null) => void;
}) {
  const [name, setName] = useState(hook?.name ?? "");
  const [url, setUrl] = useState(hook?.url ?? "https://");
  const [picked, setPicked] = useState<string[]>(
    hook?.events ?? ["leave_application.approved"],
  );
  const [active, setActive] = useState(hook?.active ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const all = picked.includes("*");
  const save = useMutation({
    mutationFn: async () => {
      const body = { name, url, events: picked, active };
      if (hook) {
        await api(`/integrations/webhooks/${hook.id}`, {
          method: "PATCH",
          body,
        });
        return null;
      }
      const r = await api<{ name: string; secret: string }>(
        "/integrations/webhooks",
        { method: "POST", body },
      );
      return { name: r.name, secret: r.secret };
    },
    onSuccess: (s) => {
      toast(hook ? "Webhook saved" : "Webhook added");
      onSaved(s);
    },
  });
  const rotate = useMutation({
    mutationFn: () =>
      api<{ secret: string }>(
        `/integrations/webhooks/${hook!.id}/rotate-secret`,
        { method: "POST", body: {} },
      ),
    onSuccess: (r) => onSaved({ name: hook!.name, secret: r.secret }),
  });
  const remove = useMutation({
    mutationFn: () =>
      api(`/integrations/webhooks/${hook!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast("Webhook removed");
      onSaved(null);
    },
  });

  return (
    <>
      <Modal
        open={!confirmDelete}
        wide
        title={hook ? `Edit ${hook.name}` : "New webhook"}
        onClose={onClose}
        footer={
          <>
            {hook && (
              <>
                <button
                  className="btn-ghost mr-auto text-bad hover:bg-bad-soft hover:text-bad"
                  onClick={() => setConfirmDelete(true)}
                >
                  Remove
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => rotate.mutate()}
                  disabled={rotate.isPending}
                >
                  New secret
                </button>
              </>
            )}
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={
                name.trim().length < 2 || picked.length === 0 || save.isPending
              }
              onClick={() => save.mutate()}
            >
              {hook ? "Save" : "Add webhook"}
            </button>
          </>
        }
      >
        <div className="space-y-5">
          <FormError message={save.error?.message ?? rotate.error?.message} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Payroll bank bridge"
              />
            </Field>
            <Field label="URL" hint="Must answer 2xx within 10 seconds">
              <input
                className="input num"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm text-ink-2">Events</p>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#3B4A9F]"
                  checked={all}
                  onChange={(e) => setPicked(e.target.checked ? ["*"] : [])}
                />
                Every event
              </label>
            </div>
            <div
              className={`grid gap-x-6 gap-y-1 sm:grid-cols-2 ${all ? "pointer-events-none opacity-50" : ""}`}
            >
              {catalog.map((e) => (
                <label
                  key={e.type}
                  className="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-bg"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-[#3B4A9F]"
                    checked={picked.includes(e.type)}
                    onChange={(ev) =>
                      setPicked(
                        ev.target.checked
                          ? [...picked.filter((p) => p !== "*"), e.type]
                          : picked.filter((p) => p !== e.type),
                      )
                    }
                  />
                  <span>
                    <span className="block text-sm">{e.label}</span>
                    <span className="num block text-xs text-ink-3">
                      {e.type}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          {hook && (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#3B4A9F]"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              On: send events to this URL
            </label>
          )}
        </div>
      </Modal>
      <ConfirmModal
        open={confirmDelete}
        title={`Remove ${hook?.name}`}
        body="No more events are sent to this URL, and its delivery log is removed."
        confirmLabel="Remove webhook"
        danger
        busy={remove.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

function Deliveries({ hook, onClose }: { hook: Hook; onClose: () => void }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<
    "all" | "failed" | "pending" | "delivered"
  >("all");
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({
    queryKey: [...KEY, "deliveries", hook.id, page, status],
    queryFn: () =>
      api<Paged<Delivery>>(`/integrations/webhooks/${hook.id}/deliveries`, {
        query: {
          page,
          pageSize: 20,
          status: status === "all" ? undefined : status,
        },
      }),
    refetchInterval: 5000,
  });
  const again = useMutation({
    mutationFn: (id: number) =>
      api(`/integrations/deliveries/${id}/redeliver`, {
        method: "POST",
        body: {},
      }),
    onSuccess: () => {
      toast("Queued to send again");
      void qc.invalidateQueries({ queryKey: [...KEY, "deliveries", hook.id] });
    },
  });
  const tone = { delivered: "good", failed: "bad", pending: "warn" } as const;

  return (
    <Modal
      open
      wide
      title={`Deliveries to ${hook.name}`}
      description={hook.url}
      onClose={onClose}
    >
      <div className="mb-3">
        <Segmented
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={[
            { value: "all", label: "All" },
            { value: "failed", label: "Failed" },
            { value: "pending", label: "Waiting" },
            { value: "delivered", label: "Sent" },
          ]}
        />
      </div>
      {q.isLoading ? (
        <Loading inline />
      ) : q.data!.data.length === 0 ? (
        <EmptyState
          bare
          title="Nothing here"
          hint="Deliveries appear as soon as a matching event happens"
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <ul className="divide-y divide-line">
            {q.data!.data.map((d) => (
              <li key={d.id}>
                <button
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg"
                  onClick={() => setOpen(open === d.id ? null : d.id)}
                >
                  <Tag tone={tone[d.status]}>
                    {d.status === "delivered"
                      ? `Sent ${d.responseStatus ?? ""}`
                      : d.status === "pending"
                        ? "Waiting"
                        : "Failed"}
                  </Tag>
                  <span className="num min-w-0 flex-1 truncate text-sm">
                    {d.eventType}
                  </span>
                  <span className="num text-xs text-ink-3">
                    {d.attempts} {d.attempts === 1 ? "try" : "tries"}
                    {d.durationMs != null ? `, ${d.durationMs} ms` : ""}
                  </span>
                  <span className="num w-28 text-right text-xs text-ink-3">
                    {dateTime(d.createdAt)}
                  </span>
                </button>
                {open === d.id && (
                  <div className="space-y-2 bg-bg px-4 pb-4 pt-1">
                    {d.error && <p className="text-xs text-bad">{d.error}</p>}
                    {d.status === "pending" && (
                      <p className="text-xs text-ink-3">
                        Next try {dateTime(d.nextAttemptAt)}
                      </p>
                    )}
                    <pre className="num max-h-64 overflow-auto rounded-lg border border-line bg-surface p-3 text-xs">
                      {JSON.stringify(d.payload, null, 2)}
                    </pre>
                    {d.status !== "pending" && (
                      <button
                        className="btn-secondary btn-sm"
                        onClick={() => again.mutate(d.id)}
                        disabled={again.isPending}
                      >
                        <RefreshCw {...ICON} className="text-ink-3" /> Send
                        again
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Pagination meta={q.data!.meta} onPage={setPage} />
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function Code({ children }: { children: string }) {
  return (
    <pre className="num overflow-x-auto rounded-xl border border-line bg-bg p-4 text-xs leading-5 text-ink">
      {children}
    </pre>
  );
}

function Guide({ catalog }: { catalog: Overview["eventCatalog"] }) {
  const origin = window.location.origin;
  const [lang, setLang] = useState<"js" | "python" | "curl">("js");
  const sections = {
    js: {
      rest: `const HRMS = '${origin}/api/v1';
const KEY = process.env.HRMS_API_KEY; // hrms_xxxxxxxx_…

// read
const res = await fetch(\`\${HRMS}/employees?status=active&pageSize=100\`, {
  headers: { Authorization: \`Bearer \${KEY}\` },
});
const { data, meta } = await res.json();

// send: apply for leave on someone's behalf (needs leave.manage)
await fetch(\`\${HRMS}/leave/applications\`, {
  method: 'POST',
  headers: { Authorization: \`Bearer \${KEY}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sipId: '2026-0004', leaveTypeId: 1, startDate: '2026-12-01', endDate: '2026-12-02', reason: 'Synced from device' }),
});`,
      ws: `import WebSocket from 'ws';

const ws = new WebSocket('${origin.replace(/^http/, "ws")}/api/v1/ws', {
  headers: { Authorization: \`Bearer \${process.env.HRMS_API_KEY}\` },
});
let lastId = 0; // persist this to resume after a restart

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe', events: ['leave_application.*', 'employee.*'], since: lastId }));
  ws.send(JSON.stringify({ type: 'request', id: 'emp', method: 'GET', path: '/employees?pageSize=5' }));
});
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'event') { lastId = msg.id; console.log(msg.event, msg.data.summary); }
  if (msg.type === 'response') console.log(msg.id, msg.status, msg.body);
});`,
      verify: `import crypto from 'node:crypto';
import express from 'express';

const app = express();
app.post('/hooks/hrms', express.raw({ type: 'application/json' }), (req, res) => {
  const ts = req.header('X-HRMS-Timestamp');
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.HRMS_WEBHOOK_SECRET)
    .update(\`\${ts}.\${req.body}\`).digest('hex');
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.header('X-HRMS-Signature') ?? ''));
  if (!ok || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.sendStatus(401);
  const event = JSON.parse(req.body);   // { id, type, occurredAt, data }
  // handle once per event.id: the same event may arrive again after a retry
  res.sendStatus(204);
});`,
    },
    python: {
      rest: `import os, requests

HRMS = "${origin}/api/v1"
H = {"Authorization": f"Bearer {os.environ['HRMS_API_KEY']}"}

employees = requests.get(f"{HRMS}/employees", params={"status": "active"}, headers=H).json()["data"]

requests.post(f"{HRMS}/leave/applications", headers=H, json={
    "sipId": "2026-0004", "leaveTypeId": 1,
    "startDate": "2026-12-01", "endDate": "2026-12-02", "reason": "Synced from device",
}).raise_for_status()`,
      ws: `import asyncio, json, os, websockets

async def main():
    url = "${origin.replace(/^http/, "ws")}/api/v1/ws"
    headers = {"Authorization": f"Bearer {os.environ['HRMS_API_KEY']}"}
    async with websockets.connect(url, additional_headers=headers) as ws:
        await ws.send(json.dumps({"type": "subscribe", "events": ["payroll_run.*"], "since": 0}))
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "event":
                print(msg["id"], msg["event"], msg["data"]["summary"])

asyncio.run(main())`,
      verify: `import hmac, hashlib, os, time
from flask import Flask, request, abort

app = Flask(__name__)

@app.post("/hooks/hrms")
def hook():
    ts = request.headers["X-HRMS-Timestamp"]
    body = request.get_data(as_text=True)
    expected = "sha256=" + hmac.new(os.environ["HRMS_WEBHOOK_SECRET"].encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, request.headers.get("X-HRMS-Signature", "")) or abs(time.time() - int(ts)) > 300:
        abort(401)
    event = request.get_json()   # handle once per event["id"]
    return "", 204`,
    },
    curl: {
      rest: `# read
curl -H "Authorization: Bearer $HRMS_API_KEY" "${origin}/api/v1/employees?status=active"

# send
curl -X POST -H "Authorization: Bearer $HRMS_API_KEY" -H "Content-Type: application/json" \\
  -d '{"sipId":"2026-0004","leaveTypeId":1,"startDate":"2026-12-01","endDate":"2026-12-02"}' \\
  "${origin}/api/v1/leave/applications"

# poll for changes instead of a webhook: keep calling with the last "next"
curl -H "Authorization: Bearer $HRMS_API_KEY" "${origin}/api/v1/integrations/events?after=0&types=employee.*"`,
      ws: `# any WebSocket client works, e.g. websocat
websocat -H "Authorization: Bearer $HRMS_API_KEY" ${origin.replace(/^http/, "ws")}/api/v1/ws
{"type":"subscribe","events":["*"]}
{"type":"request","id":1,"method":"GET","path":"/dashboard/counts"}`,
      verify: `# what a delivery looks like
POST /hooks/hrms
Content-Type: application/json
X-HRMS-Event: leave_application.approved
X-HRMS-Delivery: 812
X-HRMS-Timestamp: 1793930000
X-HRMS-Signature: sha256=<hex HMAC-SHA256 of "1793930000.<body>">

{"id":5121,"type":"leave_application.approved","occurredAt":"2026-11-06T10:42:00Z",
 "data":{"entity":"leave_application","id":"14","summary":"approved 2 days …","actor":{…},"record":{…}}}`,
    },
  }[lang];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-ink-2">Examples in</p>
          <Segmented
            value={lang}
            onChange={setLang}
            options={[
              { value: "js", label: "JavaScript" },
              { value: "python", label: "Python" },
              { value: "curl", label: "curl" },
            ]}
          />
        </div>
        <div className="card p-5">
          <p className="card-title">1. Read and send data</p>
          <p className="mb-3 mt-1 text-sm text-ink-2">
            Every screen in this app uses the same REST API at{" "}
            <code className="num text-xs">{origin}/api/v1</code>. A key can call
            any endpoint its permissions allow. Lists take{" "}
            <code className="num text-xs">page</code> and{" "}
            <code className="num text-xs">pageSize</code> (up to 200) and return{" "}
            <code className="num text-xs">{"{ data, meta }"}</code>. Errors
            return <code className="num text-xs">{"{ error, message }"}</code>{" "}
            with a 4xx status. Each key may make 600 requests a minute.
          </p>
          <Code>{sections.rest}</Code>
        </div>
        <div className="card p-5">
          <p className="card-title">2. Live connection (WebSocket)</p>
          <p className="mb-3 mt-1 text-sm text-ink-2">
            Events arrive as they happen. Send{" "}
            <code className="num text-xs">since</code> with the last id you
            handled to get anything you missed. Requests sent over the socket
            behave exactly like HTTP calls with the same key. Browser apps on
            another site first get a one-time ticket from{" "}
            <code className="num text-xs">POST /api/v1/realtime/ticket</code>{" "}
            and connect to{" "}
            <code className="num text-xs">/api/v1/ws?ticket=…</code>.
          </p>
          <Code>{sections.ws}</Code>
        </div>
        <div className="card p-5">
          <p className="card-title">3. Webhooks: check the signature</p>
          <p className="mb-3 mt-1 text-sm text-ink-2">
            Answer with any 2xx within 10 seconds. Anything else is retried
            after 30 s, 1 min, 2 min and so on, eight tries in all. The same
            event can arrive twice, so handle each{" "}
            <code className="num text-xs">id</code> once. Payloads never include
            CNIC, bank or date of birth; fetch the record with your key if you
            need more.
          </p>
          <Code>{sections.verify}</Code>
        </div>
      </div>
      <div className="card self-start">
        <div className="card-head">
          <p className="card-title">Events</p>
        </div>
        <ul className="divide-y divide-line border-t border-line">
          {catalog.map((e) => (
            <li key={e.type} className="px-5 py-2.5">
              <p className="num text-xs">{e.type}</p>
              <p className="text-xs text-ink-3">{e.label}</p>
            </li>
          ))}
          <li className="px-5 py-3 text-xs text-ink-3">
            Patterns: <code className="num">*</code> for everything,{" "}
            <code className="num">employee.*</code> for one module
          </li>
        </ul>
      </div>
    </div>
  );
}
