# Official Docker image (with a bundled browser)

**Date:** 2026-08-11

## Problem

shadok-ai documents a Docker mode but ships **no Dockerfile** — every deployment
hand-rolls its own image. Worse, a fresh container has **no browser**, so an
agent asked to screenshot or drive a web page spends its first minutes running
`npx playwright install --with-deps chromium` into the volume — every container,
every time. (Observed live on the "onboarding" channel doing exactly that.)

## Goal

Ship an official, versioned `Dockerfile` at the repo root that a user can
`docker build -t shadok-ai .` and run, with a **headless browser bundled in** so
agents can screenshot / drive the web out of the box.

## Design

Single-stage `FROM node:22-slim` (matches the existing hand-rolled deployment
image), three layers:

1. **System deps** — `git openssh-client tmux ca-certificates curl jq python3
   make g++`, plus `gh` from GitHub's apt repo. These are what agents and the
   pilot already rely on.
2. **Bundled browser** — `npx playwright@<pinned> install --with-deps chromium`
   into `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers`, baked into the image
   layer (not the volume). Pinned (currently `1.62.1`) so the baked browser build
   matches the resolver `npx playwright` gives an agent. `--with-deps` is the
   load-bearing part: it installs the OS libraries a browser needs, so even a
   script that pulls a *different* Playwright build still launches — only the
   browser binary is re-fetched, never the apt libraries (which need root).
3. **The cockpit** — `npm install -g @anthropic-ai/claude-code shadok-ai`.

`WORKDIR /workspace`, `EXPOSE 3789`, default `CMD ["shadok-ai", "--no-telegram"]`
(web-only; expose via `SHADOK_HOST=0.0.0.0` + password, add Telegram from the GUI).

A `.dockerignore` of `*` sends an empty build context: the image COPYs nothing
(it installs from npm), so the context is pure overhead and could otherwise carry
the repo's own files into the build.

### Why Playwright Chromium (not apt chromium)

It is what the codebase's own visual-verification pattern and the onboarding
agent already use, so a bundled Playwright browser removes a real, observed
runtime cost. `--with-deps` still lays down the system libraries, so Puppeteer or
a differently-pinned Playwright also work; only apt-`chromium`-by-path callers
would need `PUPPETEER_EXECUTABLE_PATH`, which is a niche not worth a second
~300 MB browser in the image.

## Verification

The Dockerfile can't be built from inside a cockpit container (no Docker socket).
It was build-verified once on the PR — a full `docker build` that installed the
apt deps and downloaded Playwright's Chromium into `/opt/playwright-browsers`
successfully. No ongoing CI gate is kept for it: shipping the image is a rare
change, and a Docker build on every relevant PR was judged not worth the
maintenance surface. Re-verify with `docker build -t shadok-ai .` when the
Dockerfile changes.

## Out of scope

- **Publishing** the image to a registry (build-only for now).
- **Adopting it for the live VPS**, which currently builds from a host-side
  Dockerfile — a separate, host-access deployment step.
