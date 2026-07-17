// Dev-server embeddability for `civitai app dev-tunnel`: the real production
// parent (civitai.com/apps/dev/<blockId>) iframes this dev server through a
// `dev-<16hex>.civit.ai` tunnel host. Single source of truth for both halves,
// imported by vite.config.ts. DEV-ONLY: vite `server.*` options never apply to
// `vite build`, so the production bundle's framing is untouched.

export const PROD_PARENT_ORIGIN = 'https://civitai.com';

/**
 * Vite's DNS-rebinding host check 403s the tunneled host unless allowed;
 * a leading-dot entry matches any subdomain.
 */
export const DEV_TUNNEL_HOST_SUFFIX = '.civit.ai';

export const DEV_ALLOWED_HOSTS: string[] = ['localhost', DEV_TUNNEL_HOST_SUFFIX];

/**
 * Deliberately NO `X-Frame-Options` — any XFO value would block the
 * cross-origin embed regardless of the frame-ancestors CSP.
 *
 * `Access-Control-Allow-Origin: *`: the tunnel embeds this server inside a
 * sandboxed NULL-origin iframe, and null-origin module-script fetches are
 * CORS-blocked without it. `*` matches how production app-blocks are served,
 * and is safe here: the dev server sits behind the authenticated tunnel gate
 * and module fetches are non-credentialed.
 */
export function devServerSecurityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': `frame-ancestors 'self' ${PROD_PARENT_ORIGIN}`,
    'Access-Control-Allow-Origin': '*',
  };
}

/**
 * Merges the env's parent-origin allowlist with the prod parent so the SAME
 * dev build works in the local harness AND embedded over the tunnel.
 */
export function devAllowedParentOrigins(envValue: string | undefined): string[] {
  const fromEnv = (envValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...fromEnv];
  if (!merged.includes(PROD_PARENT_ORIGIN)) merged.push(PROD_PARENT_ORIGIN);
  return merged;
}
