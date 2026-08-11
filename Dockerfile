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
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client tmux ca-certificates curl jq python3 make g++ \
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

# Web-only by default. To expose it, set SHADOK_HOST=0.0.0.0 + a password and
# publish on the host loopback (-p 127.0.0.1:3789:3789); add a Telegram token
# later from the GUI. See README "Running in Docker".
CMD ["shadok-ai", "--no-telegram"]
