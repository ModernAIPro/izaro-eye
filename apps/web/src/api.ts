export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`/api${path}`, {
    ...rest,
    headers: json !== undefined ? { 'content-type': 'application/json', ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const imageUrl = (key: string) => `/api/images/${key}`;

/**
 * Where WebSockets connect. Normally the page's own host. When the UI is served
 * from a host that only proxies HTTP to the server (Vercel), set VITE_WS_ORIGIN
 * at build time to the server's own origin, e.g. `wss://api.starkfarms.in`.
 */
const wsOrigin = import.meta.env.VITE_WS_ORIGIN?.replace(/\/$/, '');

export function wsUrl(path: string) {
  if (wsOrigin) return `${wsOrigin}/api${path}`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api${path}`;
}
