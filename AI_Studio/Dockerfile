# AI Testing Platform: API + worker + UI in one image.
# Node 24 is required (node:sqlite); Chromium and its OS dependencies come from Playwright.
FROM node:24-bookworm-slim

WORKDIR /app

# Browsers in a shared path, so the unprivileged runtime user (below) can launch them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
# Dev dependencies are kept on purpose: tsx runs the TypeScript sources and Vite builds the UI.
RUN npm ci --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY installer ./installer
COPY examples ./examples
RUN npm run build:web
# The runner kit (the download in Setup, Runners): the agent and engine bundled for computers without a checkout.
# With --complete it also builds the complete downloads (their own Node.js, checked against nodejs.org's SHASUMS256.txt, and every pinned
# package), about 55 to 70 MB each, so the image grows by roughly 400 MB for all six. Fewer: --build-arg RUNNER_COMPLETE_TARGETS=win-x64,mac-arm64;
# none: --build-arg RUNNER_COMPLETE_TARGETS=none (the complete choice is then not offered). See docs/features/runner-complete-kit.md.
ARG RUNNER_COMPLETE_TARGETS=all
RUN npm run build:runner -- --complete --targets "$RUNNER_COMPLETE_TARGETS" && rm -rf dist/runner-cache
# The runner installers (the Installer choice in Add a runner). The Mac app is plain files and builds here. The Windows program needs the C# compiler
# that only Windows has, so it is not built in this image: put a prebuilt exe at installer/prebuilt/AITestingRunnerSetup.exe before docker build, or
# build dist/installer on Windows and set RUNNER_INSTALLER_DIR to it. Without either, the Installer choice is offered for Mac only and the rest get the plain files.
RUN if [ -f installer/prebuilt/AITestingRunnerSetup.exe ]; then npm run build:installer -- --windows-exe installer/prebuilt/AITestingRunnerSetup.exe; else npm run build:installer -- --skip-windows; fi

# Listen on all interfaces inside the container. Set API_KEY when exposing the port.
ENV HOST=0.0.0.0 \
    PORT=4000 \
    DATA_DIR=/data \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 4000

# Drop root: the browser and the generated scripts run as an unprivileged user.
# /backups: where deploy/docker-compose.prod.yml mounts the scheduled backups (BACKUP_DIR); created here so a new volume is writable by the user.
RUN useradd --create-home --uid 10001 runner && mkdir -p /data /backups /app/.validation && chown -R runner /data /backups /app/.validation
USER runner

# Liveness: /healthz (process answers). Readiness (/readyz: database, migrations, worker, disk) is checked by deploy/docker-compose.prod.yml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node itself is the main process (not npx), so `docker stop` (SIGTERM) reaches the platform's graceful shutdown: the running job gets
# SHUTDOWN_GRACE_SECONDS (default 60) to finish. Give the container more than that to stop (stop_grace_period in compose, --time for docker stop).
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "src/main.ts"]
