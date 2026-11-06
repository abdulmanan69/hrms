/** One format per kind of value, used everywhere. */

const pkr = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** 9541760 → "9,541,760". The PKR unit is shown once per block, not on every figure. */
export function money(value: number | null | undefined): string {
  if (value == null) return '—';
  return pkr.format(Math.round(value));
}

/** Leave days: 2 → "2", 1.5 → "1.5" */
export function days(value: number | null | undefined): string {
  if (value == null) return '—';
  return num1.format(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-11-06' → "Nov 6, 2026" (or "Nov 6" with short) */
export function date(iso: string | null | undefined, short = false): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return short ? `${MONTHS[m - 1]} ${d}` : `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** '2026-11' → "November 2026" */
export function month(ym: string | null | undefined): string {
  if (!ym) return '—';
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

/** "Nov 10", "Nov 10–11", "Nov 28 – Dec 2" (year shown when not the current year) */
export function dateRange(from: string, to: string): string {
  const thisYear = new Date().getFullYear();
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const yr = fy !== thisYear || ty !== thisYear ? `, ${ty}` : '';
  if (from === to) return `${MONTHS[fm - 1]} ${fd}${yr}`;
  if (fy === ty && fm === tm) return `${MONTHS[fm - 1]} ${fd}–${td}${yr}`;
  return `${MONTHS[fm - 1]} ${fd} – ${MONTHS[tm - 1]} ${td}${yr}`;
}

/** Timestamp → "Nov 6, 10:42" */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Timestamp → "10:42" today, "Yesterday", or "Nov 4" */
export function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diffDays === 1) return 'Yesterday';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Local today as 'YYYY-MM-DD' */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** snake_case value → "Sentence case" label */
export function label(value: string | null | undefined): string {
  if (!value) return '—';
  const s = value.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** First + middle initial + last */
export function personName(p: { firstName: string; middleInitial?: string | null; lastName: string }): string {
  const mi = p.middleInitial?.trim();
  return [p.firstName, mi ? `${mi.replace(/\.$/, '')}.` : null, p.lastName].filter(Boolean).join(' ');
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !w.endsWith('.'))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** For 'sent …' phrases: 'today', 'yesterday' or 'on Nov 2' */
export function sentWhen(iso: string | null | undefined): string {
  const r = relative(iso);
  if (r === 'Yesterday') return 'yesterday';
  return /^\d/.test(r) ? 'today' : `on ${r}`;
}
