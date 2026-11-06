import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { ChooseCompanyError, useAuth } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { Field, FormError } from '../components/ui';

export function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** set when the email and password match accounts in several companies */
  const [choices, setChoices] = useState<Array<{ slug: string; name: string }> | null>(null);
  const [company, setCompany] = useState('');

  const from = (location.state as { from?: string } | null)?.from ?? '/';
  if (user) return <Navigate to={from} replace />;

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_minmax(0,560px)]">
      <div className="flex flex-col justify-between px-6 py-8 sm:px-12 lg:px-16">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-ink text-xs font-semibold text-white">W</span>
          <span className="text-[15px] font-semibold">WaveTech</span>
          <span className="text-[15px] text-ink-3">HRMS</span>
        </div>

        <form
          className="mx-auto w-full max-w-sm py-16"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await login(email, password, choices ? company : undefined);
              navigate(from, { replace: true });
            } catch (err) {
              if (err instanceof ChooseCompanyError) {
                setChoices(err.companies);
                setCompany(err.companies[0]?.slug ?? '');
              } else setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <h1 className="text-[28px] font-medium leading-tight tracking-[-0.01em]">Sign in</h1>
          <p className="mt-2 text-sm text-ink-2">Recruitment, staff, payroll and leave on one record</p>
          <div className="mt-8 space-y-4">
            <FormError message={error} />
            <Field label="Email">
              <input
                type="email"
                className="input h-10"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setChoices(null);
                }}
                autoComplete="username"
                autoFocus
                required
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                className="input h-10"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            {choices && (
              <fieldset className="pop">
                <legend className="mb-1.5 text-sm text-ink-2">Company</legend>
                <p className="mb-2 text-xs text-ink-3">You have an account in more than one company. Pick where to work</p>
                <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                  {choices.map((c) => (
                    <label key={c.slug} className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors ${company === c.slug ? 'bg-raised' : 'hover:bg-bg'}`}>
                      <input
                        type="radio"
                        name="company"
                        className="h-4 w-4 accent-[#3B4A9F]"
                        checked={company === c.slug}
                        onChange={() => setCompany(c.slug)}
                      />
                      <span className="flex-1 text-sm">{c.name}</span>
                      <span className="num text-xs text-ink-3">{c.slug}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <button type="submit" className="btn-primary h-10 w-full justify-center" disabled={busy}>
              {busy && <Loader2 size={16} strokeWidth={1.5} className="animate-spin" />}
              Sign in
            </button>
          </div>
        </form>

        <p className="text-xs text-ink-3">Forgot your password? Ask HR to reset it</p>
      </div>

      {/* The idea of the product in one picture: a salary sheet that reconciles */}
      <aside className="relative hidden overflow-hidden border-l border-line bg-surface lg:block">
        <div className="absolute inset-0 bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_39px,rgba(23,23,23,0.05)_39px,rgba(23,23,23,0.05)_40px)]" />
        <div className="relative flex h-full flex-col justify-center px-14">
          <p className="text-sm text-ink-3">One person, one record</p>
          <ol className="mt-6 space-y-0">
            {[
              ['Applied', 'Application received'],
              ['Hired', 'SIP 2026-0124 issued'],
              ['Paid', 'A + B − C, every month'],
              ['On leave', 'Balance kept as a ledger'],
            ].map(([k, v], i) => (
              <li key={k} className="flex h-10 items-center gap-4">
                <span className="num w-6 text-xs text-ink-3">{String(i + 1).padStart(2, '0')}</span>
                <span className="w-20 text-sm font-medium">{k}</span>
                <span className="text-sm text-ink-2">{v}</span>
              </li>
            ))}
          </ol>
          <div className="mt-6 flex h-10 items-center gap-4 border-y-[3px] border-double border-ink/15">
            <span className="num w-6 text-xs text-ink-3">=</span>
            <span className="text-sm text-ink-2">No name typed twice</span>
          </div>
        </div>
      </aside>
    </div>
  );
}
