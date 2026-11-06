export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, string[]>,
    /** companies to choose from when sign-in finds the email in several */
    public companies?: Array<{ slug: string; name: string }>,
  ) {
    super(message);
  }
}

export const API_BASE = '/api/v1';

/**
 * The company this page was loaded for. Sent with every request; the server
 * refuses a request whose company no longer matches the session (another tab
 * switched company), so a stale page can never write into the wrong company.
 */
let pageCompanyId: number | null = null;
export function setPageCompany(id: number | null): void {
  pageCompanyId = id;
}
function companyHeader(): Record<string, string> {
  return pageCompanyId ? { 'x-company-id': String(pageCompanyId) } : {};
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  let url = `${API_BASE}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code = 'request_error';
    let message = `Request failed (${res.status})`;
    let details: Record<string, string[]> | undefined;
    let companies: Array<{ slug: string; name: string }> | undefined;
    try {
      const data = await res.json();
      code = data.error ?? code;
      message = data.message ?? message;
      details = data.details;
      companies = data.companies;
    } catch {
      // non-JSON error body
    }
    if (code === 'company_changed') {
      // this page belongs to another company than the session now: start over
      window.location.assign('/');
    }
    if (res.status === 401 && !location.pathname.startsWith('/login')) {
      window.dispatchEvent(new Event('hrms:unauthorized'));
    }
    throw new ApiError(res.status, code, message, details, companies);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** JSON request to the API. Throws ApiError with the server's message on failure. */
export async function api<T>(path: string, options: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  const res = await fetch(withQuery(path, options.query), {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: { ...companyHeader(), ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return handle<T>(res);
}

/** Multipart upload: one file plus plain fields. */
export async function upload<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const form = new FormData();
  // fields first: the server reads them before the file stream
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', file);
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', credentials: 'same-origin', headers: companyHeader(), body: form });
  return handle<T>(res);
}

/** URL for a GET download (CSV export, document) that the browser opens directly. */
export function downloadUrl(path: string, query?: Query): string {
  return withQuery(path, query);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paged<T> {
  data: T[];
  meta: PageMeta;
}
