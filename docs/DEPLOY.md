# Deploying: UI on Vercel, server on a Mac through a Cloudflare Tunnel

The web UI is a Vercel service (`vercel.json`). Vercel forwards `/api/*` to
`https://api.starkfarms.in`, which a Cloudflare Tunnel connects to the server
running on a Mac. Data (SQLite, images, videos) stays in the Mac's `DATA_DIR`.
The site works only while the Mac is awake and the server and tunnel are running.

## 1. Move starkfarms.in's DNS to Cloudflare (once)

A tunnel can only publish a hostname in a zone that Cloudflare runs, so this step is required.

1. Sign up at dash.cloudflare.com (the free plan is enough), click **Add a domain**, and enter `starkfarms.in`.
2. At your registrar, change the nameservers to the two Cloudflare gives you. Wait for the zone to show **Active**.
3. In Cloudflare **DNS**, keep the Vercel records for the site, with the proxy set to **DNS only** (grey cloud):
   - `A` record: `@` → `76.76.21.21`, or the value Vercel's Domains page shows
   - `CNAME` record: `www` → `cname.vercel-dns.com`

## 2. Run the server on the Mac

Use Node 26 and pnpm 10 or later, from the repo checkout on the `mvp` branch.

```sh
pnpm install
pnpm --filter @izaro/server exec playwright install chromium
cp .env.example .env   # then fill in TYPESAFE_API_KEY, AUT_PASSWORD; keep .env out of git
DATA_DIR="$HOME/izaro-data" pnpm --filter @izaro/server start
```

Check that `http://localhost:4000/api/health` returns `{"ok":true,...}`.

## 3. Create the tunnel (once)

```sh
brew install cloudflared
cloudflared tunnel login                 # pick starkfarms.in in the browser
cloudflared tunnel create izaro-eye
cloudflared tunnel route dns izaro-eye api.starkfarms.in
```

Create `~/.cloudflared/config.yml`. `cloudflared tunnel create` prints the tunnel id.

```yaml
tunnel: izaro-eye
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: api.starkfarms.in
    service: http://localhost:4000
  - service: http_status:404
```

Then run it with `cloudflared tunnel run izaro-eye`, or install it as a service that
starts at login with `sudo cloudflared service install`.
`https://api.starkfarms.in/api/health` should now answer.

## 4. Vercel

- **Settings → Environment Variables:** add `VITE_WS_ORIGIN` = `wss://api.starkfarms.in`
  for Production and Preview. WebSockets (live runs, the recorder) connect to the
  server directly, because Vercel's `/api` proxy only carries HTTP.
- Remove the old server variables from Vercel, such as `TYPESAFE_API_KEY`. They now live in the Mac's `.env`.
- Redeploy `mvp`.

## Keeping it up

- Stop the Mac from sleeping while serving: run `caffeinate -s` in the terminal that runs the server,
  or change the setting in **System Settings → Battery/Energy**.
- Back up `~/izaro-data`. It holds every project, baseline and video.
