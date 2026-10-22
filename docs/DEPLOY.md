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
cp .env.example apps/server/.env   # fill in TYPESAFE_API_KEY, AUT_PASSWORD; the server reads .env from apps/server
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

Then run it with `cloudflared tunnel run izaro-eye`, or keep it running with launchd (see
[Run both at login](#run-both-at-login-launchd)). Don't use `brew services start cloudflared`:
it starts cloudflared without the `izaro-eye` tunnel, and the site returns 530.
`https://api.starkfarms.in/api/health` should now answer.

## 4. Vercel

- **Settings → Environment Variables:** add `VITE_WS_ORIGIN` = `wss://api.starkfarms.in`
  for Production and Preview. WebSockets (live runs, the recorder) connect to the
  server directly, because Vercel's `/api` proxy only carries HTTP.
- Remove the old server variables from Vercel, such as `TYPESAFE_API_KEY`. They now live in `apps/server/.env` on the Mac.
- Redeploy `mvp`.

## Keeping it up

- Stop the Mac from sleeping while serving: run `caffeinate -s` in the terminal that runs the server,
  or change the setting in **System Settings → Battery/Energy**.
- Back up `~/izaro-data`. It holds every project, baseline and video.

## Run both at login (launchd)

`deploy/macos/` has two launchd jobs: `com.izaro.server.plist` (the server) and
`com.izaro.tunnel.plist` (the tunnel). Both start at login and restart themselves if they crash.
Change `/Users/dechrish` to your home folder, and the cloudflared path to the output of `which cloudflared`. Then:

```sh
cp deploy/macos/com.izaro.*.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/com.izaro.*.plist      # both must print OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.izaro.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.izaro.tunnel.plist
```

The server job expects the repo at `~/izaro-eye`. Don't keep it in `~/Documents`, `~/Desktop`
or `~/Downloads`: macOS blocks launchd jobs from those folders (`getcwd: Operation not permitted`).

## Runbook: when the site is down

The site works when two launchd jobs are running on the old Mac:

| Job | What it does | Logs |
|---|---|---|
| `com.izaro.server` | API server on port 4000 (repo in `~/izaro-eye`) | `~/izaro-data/server.log`, `server-error.log` |
| `com.izaro.tunnel` | Cloudflare Tunnel `izaro-eye` → `api.starkfarms.in` | `~/izaro-data/tunnel.log`, `tunnel-error.log` |

Both start at login and restart on their own if they crash (`KeepAlive`).

### 1. Find out which half is down

```sh
launchctl list | grep izaro                # both should have a PID in the first column
curl localhost:4000/api/health              # server: {"ok":true,...}
cloudflared tunnel info izaro-eye           # tunnel: at least one CONNECTOR row
curl https://api.starkfarms.in/api/health   # both together
```

What the site shows:
- **530 / Cloudflare error 1033**: the tunnel is not connected. Go to step 3.
- **502**, or `connection refused` in `tunnel-error.log`: the tunnel is up and the server is down. Go to step 2.
- **A run stuck on "Waiting for the browser…"**: open the run's log. The browser start error is shown there (step 4).

### 2. Server

```sh
launchctl kickstart -k gui/$(id -u)/com.izaro.server    # restart
tail -30 ~/izaro-data/server-error.log                  # if it still doesn't answer
```

If it isn't listed at all (for example, after editing the plist):

```sh
launchctl bootout gui/$(id -u)/com.izaro.server 2>/dev/null
plutil -lint ~/Library/LaunchAgents/com.izaro.server.plist   # must print OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.izaro.server.plist
```

### 3. Tunnel

Same commands, with `com.izaro.tunnel`:

```sh
launchctl kickstart -k gui/$(id -u)/com.izaro.tunnel
tail -30 ~/izaro-data/tunnel-error.log
```

Don't use `brew services start cloudflared`. It starts cloudflared without the `izaro-eye` tunnel.

### 4. Browser doesn't start during a run

```sh
cd ~/izaro-eye && pnpm --filter @izaro/server exec playwright install chromium
```

If that still fails on this macOS version, add `BROWSER_CHANNEL=chrome` to `apps/server/.env` to use Google Chrome, then restart the server (step 2).

### 5. Updating the code

```sh
cd ~/izaro-eye && git pull && pnpm install
launchctl kickstart -k gui/$(id -u)/com.izaro.server
```

### Gotchas

- Keep the repo **outside** `~/Documents`, `~/Desktop` and `~/Downloads`. macOS blocks launchd jobs from reading those folders, which shows up as `getcwd: Operation not permitted`.
- Settings and keys live in `~/izaro-eye/apps/server/.env`.
- Keep the Mac from sleeping: `sudo pmset -a sleep 0 disablesleep 1` (undo with `sudo pmset -a disablesleep 0`).
- Back up `~/izaro-data`. It holds all projects, baselines and videos.
