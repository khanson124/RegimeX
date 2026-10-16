# Worker images built away from the trading server

## What changes

`docker/Dockerfile.worker` installs from workspace manifests before copying source.
Ordinary worker/library source edits reuse dependency installation and Prisma generation.
A schema change reruns generation; a manifest/lockfile change reruns installation.
When adding a workspace package, add its manifest to the worker Dockerfile before
the install layer.
The worker-specific Docker ignore file sends only worker/shared-package inputs, not
research datasets, other applications, local dependencies or environment files.

The **Worker image (build only)** GitHub Actions workflow builds `linux/amd64` on
GitHub-hosted compute on relevant pushes to `main` or `codex/demo-lifecycle-bypass`.
It uses persistent BuildKit layer caching, typechecks production source, and runs
the 16 connection/routing tests with excluded tests mounted read-only. It publishes
only after those checks pass, using the workflow's short-lived `GITHUB_TOKEN`.
No server SSH key, MT5 credential, `.env`, migration, engine control or deployment
is part of CI. A push is not deployment approval.

The image is tagged `ghcr.io/khanson124/regimex-worker:sha-<full-commit>` and labeled
with that commit. Use the immutable reference in `image-digest.txt` from the release
artifact or run summary for deployment. Tags alone are not deployment identities.
Other services' Dockerfiles and both existing Compose files are unchanged.

## Registry access and transfer

GHCR package visibility/access is separate from repository visibility. A public
repository does not establish anonymous image access. Before any DEMO stop, confirm
that the server can pull the chosen digest. For a private package use an approved
read-only registry credential via `docker login ghcr.io --password-stdin`; never put
a registry token in Git, shell arguments, CI output, or the trading `.env`.

If registry authentication is unavailable, manually run the workflow with
`export_image=true`. Its three-day release artifact then includes a gzip Docker
archive and checksum. Download from the trusted workflow run and transfer it to
the server. Verify the checksum, then `gzip -dc worker-image.tar.gz | docker load`.
Resolve its immutable local ID with `docker image inspect --format '{{.Id}}'
<sha-tag>` and pass that ID to preflight/Compose instead of a registry digest.
This path does not require a registry token on the server. Ordinary push runs
upload only the small release-reference files, not an additional large archive.

Image pulling/loading still takes network, disk and CPU time. The improvement
removes dependency compilation and image building/exporting from Oracle; it does
not guarantee a fixed deployment duration. The first hosted build populates cache.
No package visibility or billing setting is changed by the repository workflow.

## Separately authorized worker-only deployment

Do all preparation while the current engines keep running:

1. Confirm successful CI for the exact approved source commit. Sync the server
   checkout through Git while preserving secrets and generated research data.
2. Read current DEMO engine configurations, positions, risk profiles, and container
   IDs/images/start times/environment hashes; save the current worker image for
   rollback. REAL must remain unarmed and untouched.
3. Pull/load the image and run the read-only preflight from `~/RegimeX`:

   ```sh
   export REGIMEX_WORKER_IMAGE='ghcr.io/khanson124/regimex-worker@sha256:<digest>'
   docker pull "$REGIMEX_WORKER_IMAGE"
   sh scripts/worker-image-preflight.sh "$REGIMEX_WORKER_IMAGE" '<full-approved-commit>'
   ```

   Preflight requires local image presence, matching checkout/revision label, and
   `linux/amd64`. It never pulls, builds, restarts or controls an engine. For the
   offline path set `REGIMEX_WORKER_IMAGE` to the loaded `sha256:<image-ID>` instead.

4. Validate the prepared image with one-off containers, always using all three files:

   ```sh
   docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml \
     -f docker-compose.worker-image.yml run --rm --no-deps --entrypoint "" \
     --workdir /app worker pnpm --filter @regimex/worker typecheck
   ```

   Mount excluded test files read-only for image test retries. Verify actual DEMO
   backend, risk/exit/session settings and readiness requirements before stopping.

Only after explicit deployment authorization:

5. Issue one authenticated `POST /engine/stop`. Confirm both DEMO sessions stopped
   cleanly; preserve open-position protection/reconciliation and do not alter DB state.
6. Recreate only the worker once, without building or pulling during the stop:

   ```sh
   docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml \
     -f docker-compose.worker-image.yml up -d --no-deps --no-build --force-recreate worker
   ```

7. Verify worker startup, zero restarts, API/database/Redis readiness, expected image,
   and unchanged environment settings. Verify both MT5 bridges and all other
   containers retain their identities/start times. Then issue exactly one
   authenticated `POST /engine/start` using the saved DEMO configurations.
8. Verify R_10 1m AUTO and XAUUSD 15m SINGLE return to `DEMO_TRADING`, with fresh
   ticks/candles and unchanged strategies/risk/session/exit settings. Stop and report
   on validation failure before a second recreation or second START.

The opt-in `docker-compose.worker-image.yml` removes only the worker's build
configuration. Its `pull_policy: never` requires image preparation first; other
service configurations inherit unchanged. Include this third file consistently
for every command in this image-based rollout. Never use broad Compose up/down.

## Rollback

Keep the previous local image tag/ID, source commit, and configuration/container
snapshots. If a check fails, stop and report rather than performing an automatic
second restart or START. After separate rollback approval, restore the previous
source via Git without resetting server-only data, select the saved previous
local image ID in `REGIMEX_WORKER_IMAGE`, verify its revision/platform, and use the
same worker-only recreation/readiness/single-START sequence. Do not rebuild an old
image during the incident or roll back DB state. No REAL/LIVE terminal or bridge
restart is involved.
