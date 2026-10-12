/** Thin client for the WanSurvey API: same-origin cookies, CSRF header on writes. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { code?: string; message?: string; ssoStartUrl?: string; [k: string]: unknown },
  ) {
    super(body?.message ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
  get code(): string | undefined {
    return this.body?.code;
  }
}

export function readCookie(name: string): string | null {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

export async function api<T = unknown>(
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    /** Lets the request finish while the page is closing (autosave on leave). */
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const csrf = readCookie('ws_csrf');
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'include',
    ...(init.keepalive ? { keepalive: true } : {}),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body ?? {});
  return body as T;
}

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
}

export interface Me {
  user: { id: string; email: string; name: string; firstName: string | null; totpEnabled: boolean };
  tenantId: string;
  tenants: TenantSummary[];
  mfaState: 'ok' | 'pending' | 'enroll';
  memberships: { role: string; projectId: string | null }[];
  permissions: string[];
  access: { state: 'ok' | 'no_role'; message: string | null };
}

export interface LoginResponse {
  mfaState: 'ok' | 'pending' | 'enroll';
  csrfToken: string;
  tenant: TenantSummary;
  tenants: TenantSummary[];
}

/** Where to send someone after sign-in, given their session state. */
export function nextRouteFor(me: Pick<Me, 'mfaState' | 'access'>): string | null {
  if (me.mfaState === 'pending') return '/login/2fa';
  if (me.mfaState === 'enroll') return '/login/2fa/setup';
  if (me.access.state === 'no_role') return '/waiting';
  return null;
}

export function ssoStartUrl(email: string, returnTo = '/'): string {
  return `/api/v1/auth/sso/start?${new URLSearchParams({ email, returnTo }).toString()}`;
}

/** Multipart upload (sample files); same cookies and CSRF header as `api`. */
export async function upload<T = unknown>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const csrf = readCookie('ws_csrf');
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: form,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body ?? {});
  return body as T;
}
