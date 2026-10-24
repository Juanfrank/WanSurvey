/** Thin client for the WanSurvey API: same-origin cookies, CSRF header on writes. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { code?: string; message?: string; ssoStartUrl?: string; [k: string]: unknown },
    /** Seconds the server asked to wait (Retry-After), when it said. */
    readonly retryAfter?: number,
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

type ApiInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Lets the request finish while the page is closing (autosave on leave). */
  keepalive?: boolean;
};

/** A request with its status and headers (for answers such as 204 with a reason header). */
export async function apiFull<T = unknown>(
  path: string,
  init: ApiInit = {},
): Promise<{ status: number; headers: Headers; body: T | null }> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const csrf = readCookie('ws_csrf');
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  const send = () =>
    fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'include',
      ...(init.keepalive ? { keepalive: true } : {}),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  let res = await send();
  // A busy server (503) asks to come back shortly: reads are tried again, twice at most, after
  // the time it gives (capped, with a little jitter). Writes are left to the caller.
  for (let i = 0; i < 2 && res.status === 503 && method === 'GET'; i++) {
    const after = Math.min(Number(res.headers.get('retry-after')) || 1, 5);
    await new Promise((ok) => setTimeout(ok, after * 1000 + Math.random() * 300));
    res = await send();
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok)
    throw new ApiError(res.status, body ?? {}, Number(res.headers.get('retry-after')) || undefined);
  return { status: res.status, headers: res.headers, body: body as T | null };
}

export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  return (await apiFull<T>(path, init)).body as T;
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
  /** Each role with what it allows in this organisation (its permissions may be customised). */
  memberships: { role: string; projectId: string | null; permissions?: string[] }[];
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

/** Microsoft sign-in; without an e-mail the deployment's organisation (SSO_DEFAULT_ORG). */
export function ssoStartUrl(email?: string, returnTo = '/'): string {
  const q = new URLSearchParams(email ? { email, returnTo } : { returnTo });
  return `/api/v1/auth/sso/start?${q.toString()}`;
}

/**
 * Opens another of the person's organisations. One that needs its own Microsoft sign-in (the
 * session came from another directory) sends the browser there; resolves `false` then.
 */
export async function switchTenant(tenantId: string): Promise<boolean> {
  try {
    await api('/auth/switch-tenant', { method: 'POST', body: { tenantId } });
    return true;
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.code === 'SSO_REQUIRED' &&
      typeof err.body.ssoStartUrl === 'string'
    ) {
      window.location.assign(err.body.ssoStartUrl);
      return false;
    }
    throw err;
  }
}

/** What the sign-in page offers (`GET /auth/methods`). */
export interface AuthMethods {
  password: boolean;
  microsoftNeedsEmail: boolean;
}

/** Multipart upload (sample files); same cookies and CSRF header as `api`. */
export async function upload<T = unknown>(
  path: string,
  form: FormData,
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const csrf = readCookie('ws_csrf');
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'include',
    body: form,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok)
    throw new ApiError(res.status, body ?? {}, Number(res.headers.get('retry-after')) || undefined);
  return body as T;
}
