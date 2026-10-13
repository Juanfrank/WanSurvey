/**
 * Response headers for the web app (H4), used by `vite preview` and mirrored in
 * `infra/nginx/templates/default.conf.template` for production. The build has no inline scripts or styles, so the
 * policy needs no nonces: scripts and styles come only from this origin.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // Map tiles for case locations (OpenStreetMap) and images Leaflet builds in memory.
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Location for CAPI interviews (this origin only); nothing else.
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
