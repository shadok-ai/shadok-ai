# Deploying one instance on your own machine

One machine, one instance, one `docker-compose.yml`. Follow it top to bottom and
you end with an HTTPS cockpit you sign into with a password.

This page is the **order of operations**. It does not re-explain the proxy
headers, the password model or the first-run screens — the README owns those, and
a second copy here would be the one that goes stale. Each step links to it.

**What you need:** a Linux machine you have root on (2 vCPU / 4 GB is
comfortable), a DNS name already pointing at it, and Docker with the Compose
plugin. Budget twenty minutes, most of it the image build.

---

## 1. Point the DNS first, and check it

certbot issues a certificate by answering an HTTP challenge on that name, so the
name has to resolve to this machine **before** you ask for one. Checking it now
costs one command; discovering it at step 5 costs a failed issuance and a rate
limit.

```bash
dig +short cockpit.example.com        # must print this machine's public address
curl -s ifconfig.me; echo            # ...which is this
```

If the name sits behind a CDN, turn the proxying **off** for it until the
certificate is issued.

## 2. Build the image, and tag it with what it is

```bash
git clone https://github.com/shadok-ai/shadok-ai && cd shadok-ai
docker build -t "shadok-ai:$(date +%F)-$(git rev-parse --short HEAD)" .
```

The tag carries a date and a commit because **you will want to know what is
running months from now**, and `latest` cannot tell you. That is not a style
preference: a tag is a label that moves, while a container keeps the image *id*
it was created with — so several containers built at different times can all
report `latest` and be running genuinely different software. Pin the id:

```bash
docker image inspect "shadok-ai:$(date +%F)-$(git rev-parse --short HEAD)" \
  --format '{{.Id}}'
```

Put that `sha256:…` in `.env` at the next step. One line to change, deliberately,
when you upgrade.

What the image contains, and why it is big: Claude Code, shadok-ai, a headless
Chromium so agents can screenshot with no first-run download, plus `git`, `gh`,
`tmux` and a C toolchain for agents' own work. See
[README "Running in Docker"](../README.md#running-in-docker).

## 3. Three files in one directory

Put them wherever you keep deployments — `/opt/shadok` is as good as anywhere.

**`.env`** — the only place a version lives:

```ini
# Pinned by id, never by a tag. Bump this one line to upgrade.
SHADOK_IMAGE=sha256:0000000000000000000000000000000000000000000000000000000000000000
```

**`shadok.env`** (mode `600` — it holds the password):

```ini
# 0.0.0.0 is the only value that works in a container: the server must listen on
# the container's interfaces for the published port to reach it. It is NOT
# exposed to the network — compose publishes on the host's loopback only.
SHADOK_HOST=0.0.0.0

# Required with SHADOK_HOST=0.0.0.0: the server refuses to start without one,
# rather than hand the network a shell. This password IS the admin account.
SHADOK_GUI_PASSWORD=generate-a-long-random-one

# The public origin, so the browser's same-origin check passes behind the proxy.
SHADOK_ORIGINS=https://cockpit.example.com
```

Generate the password rather than inventing one, and read it back from the file
instead of echoing it into a terminal that keeps history:

```bash
umask 077
printf 'SHADOK_GUI_PASSWORD=%s\n' "$(openssl rand -base64 24)" >> shadok.env
```

**`docker-compose.yml`:**

```yaml
# One machine, one instance. Two rules hold this file together:
#
#  1. The image is pinned by ID in .env, never by a moving tag. A tag can point
#     somewhere new between two `up`s, which upgrades the instance silently —
#     and silently is the one way you do not want to change versions.
#  2. Nothing mutable lives outside a volume. `docker restart` keeps the
#     container's writable layer, but `docker rm` + recreate erases it — and
#     recreating is the ordinary way to change image or environment. So
#     everything the instance writes is mounted, with no exceptions.

name: shadok

services:
  cockpit:
    image: ${SHADOK_IMAGE:?pin SHADOK_IMAGE in .env}
    container_name: shadok
    restart: unless-stopped
    working_dir: /workspace
    command: ["shadok-ai", "--no-telegram"]
    env_file: [./shadok.env]

    # Published on the host's loopback only: the proxy is the single door, and
    # the proxy is what carries TLS. Plain "3789:3789" would publish on every
    # interface AND bypass ufw/firewalld, because Docker writes its iptables
    # rules upstream of them.
    ports:
      - "127.0.0.1:3789:3789"

    volumes:
      # Instance state: agents, groups, profiles, scheduled prompts, the secret
      # vault, attachments, the container's SSH identity — and the self-updated
      # copy of the cockpit itself, which is why upgrades survive a recreate.
      - shadok-data:/root/.shadok-ai
      # The Claude sign-in and the transcripts. Every line of content the cockpit
      # displays is read back from those transcripts: losing this volume loses
      # the history, not just the session.
      - claude-home:/root/.claude
      # What the agents work on.
      - workspace:/workspace
      # Empty on a single-user instance, and mounted anyway. A deployment with
      # isolated groups puts each group's home here (live transcripts, memories,
      # keys, worktrees). Mounting them now costs nothing; adding them later
      # means a recreate, and a recreate is exactly what erases whatever was
      # sitting on the writable layer in the meantime.
      - userhomes:/home
      - varlib:/var/lib/shadok-ai

    # 401 is the RIGHT answer from a password-protected instance, so this asks
    # "does the server answer", not "does it let me in". `curl -f` here would
    # report every correctly-protected instance as sick.
    healthcheck:
      test: ["CMD-SHELL", "curl -s -o /dev/null -w '%{http_code}' localhost:3789/ | grep -qE '200|401'"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s

volumes:
  shadok-data:
  claude-home:
  workspace:
  userhomes:
  varlib:
```

Start it, and check compose agrees with you before it runs anything:

```bash
docker compose config -q && docker compose up -d
docker compose ps        # healthy after a minute or so
```

## 4. The proxy

Terminate TLS in nginx (or Caddy) in front of the published loopback port. The
configuration — and the three traps that each produce a *silent* failure rather
than an error — is in
[README "Behind TLS"](../README.md#behind-tls-nginx-caddy). Read it rather than
improvising; in short:

- **forward `Upgrade`/`Connection`**, or the page loads perfectly and no agent
  ever connects;
- **`client_max_body_size 50m`**, or pasting a screenshot fails at the proxy,
  before the cockpit sees it;
- **forward `X-Forwarded-For` and `X-Forwarded-Proto`**, which is what lets the
  server tell a relayed request from a local one, and what makes the session
  cookies `Secure`.

## 5. The certificate

```bash
sudo certbot --nginx -d cockpit.example.com --redirect
```

`--redirect` is what sends plain HTTP to HTTPS. Without it the cockpit answers on
both, and a browser on `http://` blocks the cockpit's own WebSocket as mixed
content — a page that renders and never connects, with nothing in the proxy log
to suggest why.

## 6. Sign in, twice

Open `https://cockpit.example.com`. The password from `shadok.env` logs you in as
the admin (leave the user field blank).

Then the cockpit asks for the **Claude sign-in** — a separate thing: shadok drives
real Claude Code sessions on a Claude subscription, so the instance needs its own.
A card takes over the page with a link and a field for the code it hands back.
Agents refuse to start until that is done, so you cannot accidentally create one
with no credentials. See
[README "Signing in to Claude"](../README.md#signing-in-to-claude).

Once signed in, the instance starts its first agent on its own and greets you.
Invite other people from the **Users** panel: each invitation is a single-use
link on which they choose their own password.

## 7. Verify, in this order

```bash
docker compose ps                                   # healthy
curl -sI https://cockpit.example.com | head -1      # 200 or 401, both fine
docker compose logs --tail 40 | grep -i 'ssh identity\|listening'
```

Then, in the browser: **open an agent and send it a prompt.** Nothing short of
that exercises the WebSocket, and the WebSocket is what the proxy breaks. A
cockpit that lists its agents and answers nothing is the exact shape of a missing
`Upgrade` header.

---

## Upgrading

Two steps, never one, and in this order:

```bash
cd shadok-ai && git pull
docker build -t "shadok-ai:$(date +%F)-$(git rev-parse --short HEAD)" .
docker image inspect "shadok-ai:$(date +%F)-$(git rev-parse --short HEAD)" --format '{{.Id}}'
# put that id in .env, then:
docker compose up -d
```

Three things are worth knowing before you do it:

**The cockpit mostly upgrades itself.** It runs under a supervisor that installs
new releases of shadok-ai into `~/.shadok-ai/app`, which is on the `shadok-data`
volume — so those upgrades survive a recreate and you do not rebuild for them.
Which stream it follows is a setting, see
[README "Update channels"](../README.md#update-channels).

**Claude Code does not.** It is installed in the image, under `/usr/local`, which
is on the container's writable layer. Its own updater writes there, and a
**recreate therefore rolls it back to the version baked into the image**. On a
container that has been running for months, that is a real downgrade, and it
surfaces as an API error naming a minimum version rather than as anything about
Docker. This is the reason to rebuild the image when you recreate, rather than
recreating on the old one.

**A recreate is not a restart.** `docker compose restart` keeps the writable
layer; `up -d` after an image change destroys the container and builds a new one.
Everything in the five volumes survives either. Anything else does not — which is
the whole reason the volume list above has no exceptions in it.

Rolling back is the same move backwards: put the previous id in `.env`, `up -d`.
Keep the old image (`docker image ls`) until you are sure; `docker image prune`
will take it otherwise.

## What this page deliberately does not give you

**Backups.** Nothing here backs anything up. The five volumes hold the sign-in,
the transcripts, the vault and the agents' work, and a `docker volume rm` or a
dead disk takes all of it. If the instance matters, snapshot
`/var/lib/docker/volumes` — or the machine — on a schedule, and test a restore
once. An untested backup is a belief, not a backup.

**Resource limits.** Agents spawn compilers and browsers; one instance can eat a
small machine. If you share the host, add `deploy.resources.limits` and find out
what the ceiling costs you under load rather than on the day it matters.

**More than one instance per machine.** It works — different published ports,
different project names — but the volume names, the proxy and the upgrade order
all multiply, and the point of this page is the single-instance case.
