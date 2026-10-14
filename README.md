# Neocloud Observatory

Public monitor: https://pppoooppyyy.github.io/neocloud-observatory/

The dashboard shares the same read-only data as the Research Portal at https://research.castoramoney.com/themes/ai_compute.

## Daily data

The Portal Worker checks public sources at 10:00 Asia/Taipei (02:00 UTC). Both dashboards read `https://research.castoramoney.com/api/neocloud/public-snapshot` on load and every 30 seconds while visible. No GitHub rebuild is needed for data updates.

Collected: Ornn/Mercatus GPU indices; Google TPU, Runpod, JarvisLabs and Spheron pricing; US Treasury curves; public CoreWeave credit disclosures; public funding releases and complete weekly funding samples. Sources without fresh data retain their real observation dates. Failed requests retain previous values. Daily releases remain separate from fixed weekly samples.

CDS remains the supplied chart dated 2026-10-01. Bond market prices/yields await an authorized source. SEC access may be restricted; the update log reports each source result.

## Publishing interface changes

Canonical source is the user's `Claude_Research/apps/pm-research-hub` workspace: `public-site/` and `components/neocloud/`. Run `npx vite build --config public-site/vite.config.mjs` there, then copy the contents of `dist/neocloud-public/` into this repository and commit. GitHub Pages serves the main branch root.

This repository contains static public assets only. It has no API credentials or write access to the Portal.
