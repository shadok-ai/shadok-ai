# syntax=docker/dockerfile:1
#
# Official shadok-ai image — a ready-to-run cockpit.
#
# Bundles Claude Code (the engine), shadok-ai (the cockpit) and a headless
# browser (Playwright Chromium) so agents can screenshot and drive the web out
# of the box, with no per-session download. See README "Running in Docker".
FROM node:22-slim

# --- System dependencies -----------------------------------------------------
# git / openssh-client : agents clone/push private repos and ssh into hosts.
# tmux                 : the pilot's default transport (survives a server restart).
# gh                   : GitHub CLI for PR / issue ops.
# jq / curl            : scripting. python3 / make / g++ : native npm modules.
# tini                 : pid 1 that REAPS. See the ENTRYPOINT below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client tmux ca-certificates curl jq python3 make g++ tini \
    && install -d -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# --- Bundled browser ---------------------------------------------------------
# Playwright Chromium plus its OS libraries, baked once into a shared image path
# so every agent finds it with no runtime download and no root. Pinned so the
# baked browser build matches the resolver an agent gets from `npx playwright`.
# `--with-deps` is the load-bearing part: it installs the apt libraries a browser
# needs, so even a script that pulls a different Playwright build still launches
# (only the browser binary is re-fetched, never the system libraries).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npx --yes playwright@1.62.1 install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# --- The cockpit -------------------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code shadok-ai

WORKDIR /workspace
EXPOSE 3789

# --- No USER directive, on purpose (Task 15) ---------------------------------
# The container runs as root so the server can provision OS users (`useradd`,
# `chown`, `setpriv`) — that is the whole isolation wall between groups. The
# commons must still NOT run as root: the first boot of a capable instance runs
# the automatic migration (`src/migrate-groups.ts`), which creates the non-root
# `main` user, chowns the existing root-owned tree to it, and from then on drops
# every commons/public spawn to `main` (`commonsOsUser`). So the non-root commons
# user is created at RUNTIME by migration, not baked in here — a static `USER`
# would strip the server of the privilege it needs to build the wall.

# --- pid 1 reaps -------------------------------------------------------------
# Without this the supervisor is pid 1, and pid 1 is the only process that can
# reap an ORPHAN: a child whose own parent exited is re-parented to it, and
# Node never waits for a process it did not spawn. So every orphan an agent
# leaves behind — a backgrounded `sleep` loop, an abandoned `esbuild` service,
# a killed `gh` — stays in the table as a zombie FOREVER. It holds no memory and
# no CPU, just a pid slot, which is why nothing surfaces until the cgroup's pid
# budget runs out and the container can no longer fork at all: no new agent, no
# `git`, no shell. Measured on a two-month-old instance: 79,055 zombies of a
# 113,098 pid budget (70%), all with ppid 1, 55% of them `sleep`; a nine-day-old
# one was already at 39,121. `src/lock.ts` documents the same fact from the other
# end — it has to treat a zombie as dead, because in a container nothing reaps.
# tini is pid 1 instead, reaps orphans as they appear, and forwards signals to
# the supervisor, so the exit codes the supervisor relies on are unchanged.
# An operator running an image without it gets the same thing from `docker run
# --init`. Either way it is fixed at CREATION: a `docker restart` clears the
# table (pid 1 restarts) but the leak starts over — see README "Running in Docker".
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]

# Web-only by default. To expose it, set SHADOK_HOST=0.0.0.0 + a password and
# publish on the host loopback (-p 127.0.0.1:3789:3789); add a Telegram token
# later from the GUI. See README "Running in Docker".
CMD ["shadok-ai", "--no-telegram"]
