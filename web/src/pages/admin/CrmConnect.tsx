import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { FormError, ICON } from '../../components/ui';

/**
 * Connecting the CRM (crm.vertexpakistan.com): one key that may only report
 * sales. The CRM sends its compliance-approved sales here every hour, credited
 * to closers and fronters by their VICIdial users. Everything is set up from
 * the web: the key is pasted into the CRM's Outgoing links screen.
 */
const SCOPES = ['sales.write'];

export function CrmConnect() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const grantable = SCOPES.every((s) => can(s as never));
  const key = useMutation({
    mutationFn: () => api<{ key: string }>('/integrations/keys', { method: 'POST', body: { name: 'CRM sales', scopes: SCOPES, expiresInDays: null } }),
    onSuccess: (r) => {
      setMade(r.key);
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
  const text = made ? `HR address: ${window.location.origin}\nAPI key:    ${made}` : '';

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <p className="card-title">Connect the CRM</p>
          <p className="text-xs text-ink-3">
            The CRM sends compliance-approved sales every hour; cancellations and chargebacks take the credit back. Permission: <span className="num">sales.write</span>
          </p>
        </div>
        {!made && (
          <button className="btn-primary btn-sm" disabled={key.isPending || !grantable} onClick={() => key.mutate()}>
            Create the CRM key
          </button>
        )}
      </div>
      <div className="space-y-4 border-t border-line px-5 py-4">
        <FormError message={key.error?.message} />
        {!grantable && <p className="text-sm text-warn">You need sales.write yourself to create this key.</p>}
        {made ? (
          <>
            <p className="text-sm text-ink-2">
              In the CRM open <span className="font-medium">Admin → Connections → Outgoing links</span>, click <span className="font-medium">Add link</span>, and paste the HR address
              and key. Click Test, then Save. One link per HR company. The key is shown once.
            </p>
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
          </>
        ) : (
          <p className="text-sm text-ink-2">The key is shown once, with what to paste into the CRM. No server settings to edit.</p>
        )}
      </div>
    </div>
  );
}
