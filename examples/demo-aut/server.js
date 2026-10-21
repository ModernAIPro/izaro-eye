// Tiny application under test for trying izaro-eye locally and for e2e tests.
// Login with admin/admin. POST /__variant {"variant":"broken"} changes the
// dashboard layout so a rerun has a real regression to detect.
import http from 'node:http';

let variant = 'normal';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 0; background: #f4f5f7; color: #222; }
  header { background: #243b6b; color: #fff; padding: 16px 24px; font-size: 20px; }
  main { padding: 24px; max-width: 720px; }
  .card { background: #fff; border-radius: 6px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.1); }
  label { display: block; margin: 8px 0 4px; }
  input, select { padding: 8px; width: 260px; border: 1px solid #bbb; border-radius: 4px; }
  button { margin-top: 12px; padding: 8px 16px; background: #2f6fde; color: #fff; border: 0; border-radius: 4px; }
  .broken .card { margin-left: 180px; width: 200px; }
  .error { color: #b00020; }
</style></head><body>${body}</body></html>`;

const loginPage = (error = '') =>
  page('Login', `<header>Acme Portal</header><main><div class="card">
  <h1>Sign in</h1>${error ? `<p class="error">${error}</p>` : ''}
  <form method="post" action="/login">
    <label for="username">Username</label><input id="username" name="username" autocomplete="off">
    <label for="password">Password</label><input id="password" name="password" type="password">
    <button type="submit" data-testid="login-submit">Sign in</button>
  </form></div></main>`);

const dashboard = (msg = '') =>
  page('Dashboard', `<header>Acme Portal</header><main class="${variant === 'broken' ? 'broken' : ''}">
  <div class="card"><h1 data-testid="welcome">Welcome, admin</h1><p>You have 3 open orders.</p></div>
  <div class="card"><h2>New order</h2>
    <form method="post" action="/orders">
      <label for="item">Item</label><input id="item" name="item">
      <label for="qty">Quantity</label>
      <select id="qty" name="qty"><option>1</option><option>2</option><option>3</option></select>
      <button type="submit">Place order</button>
    </form>
    ${msg ? `<p id="status" data-testid="status">${msg}</p>` : ''}
  </div></main>`);

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

const authed = (req) => /(?:^|;\s*)session=ok/.test(req.headers.cookie ?? '');

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html', ...headers });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/__variant') {
      variant = JSON.parse((await readBody(req)) || '{}').variant ?? 'normal';
      res.end(variant);
    } else if (url.pathname === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('username') === 'admin' && form.get('password') === 'admin')
        html(302, '', { location: '/dashboard', 'set-cookie': 'session=ok; Path=/' });
      else html(401, loginPage('Invalid username or password'));
    } else if (url.pathname === '/login' || url.pathname === '/') {
      html(200, loginPage());
    } else if (!authed(req)) {
      html(302, '', { location: '/login' });
    } else if (url.pathname === '/dashboard') {
      html(200, dashboard());
    } else if (url.pathname === '/orders' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      html(200, dashboard(`Order placed: ${form.get('qty')} x ${form.get('item')}`));
    } else {
      html(404, page('Not found', '<main><h1>Not found</h1></main>'));
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 5050);
  createServer().listen(port, () => console.log(`demo AUT on http://localhost:${port} (admin/admin)`));
}
