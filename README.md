# Neocloud Observatory

Public monitor: [Neocloud Observatory](https://pppoooppyyy.github.io/neocloud-observatory/).

The dashboard shares the same read-only data as the [Research Portal](https://research.castoramoney.com/themes/ai_compute).

**Activation pending:** the collector and synchronization code are prepared, but dedicated sync-token setup is awaiting approval. Daily automation is not yet confirmed as enabled. Confirm deployment, secret configuration and the first saved Actions run before treating it as active.

## Daily data

GitHub Actions is the collection runner. `.github/workflows/neocloud-daily.yml` schedules UTC 02:00, approximately 10:00 Asia/Taipei; GitHub queues can delay the start. It also supports manual dispatch and main-branch pushes that change the collector, scripts or workflow. Runs use Node.js 22, need no npm installation, share one concurrency group and have a 10-minute timeout.

Both dashboards read `https://research.castoramoney.com/api/neocloud/public-snapshot` on load, every 30 seconds while visible, and when the page becomes visible again. Frontend sync buttons only perform GET requests. Failed syncs retain the displayed data and original dates. No GitHub rebuild is needed for data updates.

Collected: Ornn/Mercatus GPU indices; Google TPU, Runpod, JarvisLabs and Spheron pricing; US Treasury curves; public CoreWeave credit disclosures; public funding releases and complete weekly funding samples. Sources without fresh data retain their real observation dates. Failed requests retain previous values. Daily releases remain separate from fixed weekly samples.

CDS remains the supplied chart dated 2026-10-01. Bond market prices/yields await an authorized source. SEC access may be restricted; the update log reports each source result.

## Synchronization and access

`scripts/collect-daily.mjs` reads the shared public snapshot, collects sources, and submits `{expectedRevision, patch, results, startedAt}` to the fixed Portal `POST /api/neocloud/collector-update` endpoint. The repository Secret `NEOCLOUD_SYNC_TOKEN` supplies a dedicated Bearer token matching the Portal secret. Its scope is this monitor's incremental data write; the endpoint rejects schedule and bond-quote changes. No general Cloudflare credential is required. Secrets are not included in assets, source files or logs, and are never sent to public data providers.

The workflow's `GITHUB_TOKEN` has only `contents: read`, checkout does not persist credentials, and the script does not commit or push files. On HTTP 409, it reads the newest snapshot and rebases the original observations with `concurrentPatch`, preserving intervening analyst edits, with at most three retries. Partial source success is reported and saved; a fully failed collection is marked failed after its check results are saved.

Portal uses its existing `WORKSPACE` Durable Object named `primary` for validation, merging and R2 snapshot saves. The packaged `ResearchWorkspace` extends the frozen production class and adds the monitor RPC while retaining its existing binding and migration. `MEDIA` R2 remains the shared current snapshot and historical archive store.

With `NEOCLOUD_EXTERNAL_SCHEDULER=github-actions`, Cloudflare's existing daily and ten-minute cron entries remain unchanged and run only their legacy handlers. They do not run a second Neocloud collector. The snapshot's schedule label alone does not prove Actions is enabled; check the workflow, secret configuration and actual run results.

Public visitors cannot trigger collection or import data through the dashboard. Portal analysts can follow the [run workflow link](https://github.com/pppoooppyyy/neocloud-observatory/actions/workflows/neocloud-daily.yml), subject to GitHub repository permissions, and can import validated increments from the same Portal origin. See [collector setup and tests](collector/README.md).

## Publishing interface changes

Canonical frontend source is the user's `Claude_Research/apps/pm-research-hub` workspace: `public-site/` and `components/neocloud/`. Build with `node node_modules/vite/bin/vite.js build --config public-site/vite.config.mjs`, then update the static assets in this repository, preserving `.github/`, `collector/`, `scripts/` and these instructions. GitHub Pages serves the main branch root. Collector modules are reviewed copies of Portal `lib/neocloud/`; keep them synchronized when source adapters change.

The public repository contains frontend assets, source collectors and tests. No credentials belong in tracked files. Runtime collector authorization exists only in the dedicated GitHub Actions secret after approved configuration.
