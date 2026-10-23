import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectNebius, parseNebiusCurrent, parseNebiusHistory, NEBIUS_API } from './nebius-collectors.ts';
import { mergeSnapshot, validatePatch, validateReferences } from './metrics.ts';

const NOW = '2026-10-23T03:00:00.000Z';
const SNAPSHOT = '2026-10-23T02:04:59.067160Z';
function empty() { return { version: 1, revision: 0, updatedAt: NOW, schedule: { time: '08:00', timezone: 'Asia/Taipei', enabled: true }, sources: [], series: [], quotes: [], deals: [], bonds: [], events: [], history: [], runs: [] }; }
const contracts = [
  ['gpu-h200-sxm', 'H200 NVLink', 'eu-north1', '2.15'],
  ['gpu-h100-sxm', 'H100 NVLink', 'eu-north1', '0.79'],
  ['gpu-rtx6000-a', 'RTX PRO 6000', 'eu-south1', '1.38'],
  ['gpu-h200-sxm', 'H200 NVLink', 'eu-west1', '5.39'],
  ['gpu-b300-sxm', 'B300 NVLink', 'eu-west2', '9.49'],
  ['gpu-b200-sxm-a', 'B200 NVLink', 'me-west1', '5'],
  ['gpu-b300-sxm', 'B300 NVLink', 'uk-south1', '9.49'],
  ['gpu-rtx6000-a', 'RTX PRO 6000', 'uk-south2', '1.38'],
  ['gpu-h200-sxm', 'H200 NVLink', 'us-central1', '0.95'],
  ['gpu-b200-sxm', 'B200 NVLink', 'us-central1', '2.3'],
  ['gpu-rtx6000', 'RTX PRO 6000', 'us-central1', '0.79'],
  ['gpu-b300-sxm', 'B300 NVLink', 'us-north1', '9.49'],
];
function current() { return { snapshotTime: SNAPSHOT, items: contracts.map(([platform, title, region, value], i) => ({ skuId: `sku-${i}`, productTitle: `Preemptible NVIDIA® ${title}`, region, computeInstance: { platform }, price: { value, currency: 'usd', unitTitle: 'GPU hour' }, effectiveTime: '2026-10-22T21:16:00Z' })) }; }
function historyFor(data = current()) { return { snapshotTime: SNAPSHOT, items: data.items.map(row => ({ skuId: row.skuId, productTitle: row.productTitle, region: row.region, computeInstance: row.computeInstance, currency: 'usd', unitTitle: 'GPU hour', points: [
  { timestamp: '2026-10-21T23:00:00Z', value: '3.2' },
  { timestamp: '2026-10-22T01:00:00Z', value: '1.1' },
  { timestamp: '2026-10-22T23:00:00Z', value: '2.2' },
  { timestamp: '2026-10-23T01:00:00Z', value: '99' },
  { timestamp: '2026-10-23T04:00:00Z', value: '88' },
] })) }; }
function response(value, extra = {}) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...extra }); }
function options(data = current(), history = historyFor(data), now = NOW) {
  return { now: () => new Date(now), fetch: async url => {
    const request = new URL(url), skus = request.searchParams.getAll('filters.skuIds');
    return response(request.pathname.endsWith('list-series') ? { ...history, items: history.items.filter(row => !skus.length || skus.includes(row.skuId)) } : data);
  } };
}

test('first run safely initializes all 12 platform-region products and nine regions without seed metadata', async () => {
  const old = empty(), untouched = structuredClone(old);
  const { patch, results } = await collectNebius(old, options());
  assert.equal(patch.quotes.length, 12);
  assert.equal(new Set(patch.quotes.map(row => row.region)).size, 9);
  assert.ok(patch.quotes.every(row => row.provider === 'Nebius' && row.market === 'spot' && row.unit === 'gpu_hour'));
  assert.ok(patch.quotes.every(row => row.seriesKey === `nebius-${row.platform}-${row.region}-spot`));
  assert.equal(patch.quotes.find(row => row.platform === 'gpu-b200-sxm-a').model, 'B200');
  assert.ok(patch.history.every(row => row.label.includes(row.platform) && row.label.includes(row.region)));
  assert.equal(validatePatch(patch), null);
  assert.equal(validateReferences(mergeSnapshot(old, patch)), null);
  assert.ok(results.every(row => row.status === 'success'));
  assert.deepEqual(old, untouched);
});

test('current API precision and source effective time survive independently of collection time', async () => {
  const { patch } = await collectNebius(empty(), options());
  const quote = patch.quotes[0], point = patch.history[0].points.at(-1);
  assert.equal(quote.observedAt, NOW);
  assert.equal(quote.sourceSnapshotAt, SNAPSHOT);
  assert.equal(quote.sourceEffectiveAt, '2026-10-22T21:16:00Z');
  assert.equal(quote.effectiveFrom, '2026-10-22');
  assert.equal(point.sourceSnapshotAt, SNAPSHOT);
});

test('strict current schema rejects wrong units, currency, title, dates, unknown platforms and duplicate keys', () => {
  const changes = [
    row => row.price.currency = 'eur', row => row.price.unitTitle = 'instance hour',
    row => row.price.value = '0', row => row.price.value = 'NaN', row => row.price.value = 2,
    row => row.price.value = '-1', row => row.price.value = '1000',
    row => row.productTitle = 'On-demand NVIDIA® H200 NVLink',
    row => row.computeInstance.platform = 'gpu-unknown', row => row.region = '../x',
    row => row.effectiveTime = '2026-02-30T00:00:00Z', row => row.effectiveTime = '2026-10-24T00:00:00Z',
  ];
  for (const change of changes) { const data = current(); change(data.items[0]); assert.throws(() => parseNebiusCurrent(data, NOW)); }
  const duplicate = current(); duplicate.items.push(duplicate.items[0]); assert.throws(() => parseNebiusCurrent(duplicate, NOW));
  assert.throws(() => parseNebiusCurrent({ ...current(), snapshotTime: '2026-10-24T00:00:00Z' }, NOW));
  assert.throws(() => parseNebiusCurrent({ ...current(), snapshotTime: '2026-10-21T00:00:00Z' }, NOW));
});

test('history uses last completed source bucket per UTC day, not a daily average or future bucket', () => {
  const data = historyFor(), products = parseNebiusCurrent(current(), NOW).items;
  data.items[0].points.reverse();
  const parsed = parseNebiusHistory(data, products, NOW);
  assert.deepEqual(parsed.items[0].points.map(point => [point.date, point.value]), [['2026-10-21', 3.2], ['2026-10-22', 2.2], ['2026-10-23', 99]]);
  const point = parsed.items[0].points[1];
  assert.equal(point.sourceBucketEndAt, '2026-10-22T23:00:00Z');
  assert.equal(point.sourceSnapshotAt, SNAPSHOT);
  assert.equal(point.observedAt, NOW);
  assert.equal(point.priceScope, 'hour_bucket_last_price');
});

test('midnight bucket closes the preceding UTC day and retains its exact source time', async () => {
  const data = historyFor(), products = parseNebiusCurrent(current(), NOW).items;
  data.items[0].points.push(
    { timestamp: '2026-10-22T00:00:00Z', value: '4.4' },
    { timestamp: '2026-10-23T00:00:00.000000Z', value: '5.5' },
    { timestamp: '2026-10-24T00:00:00Z', value: '6.6' },
  );
  const parsed = parseNebiusHistory(data, products, NOW).items[0].points;
  assert.deepEqual(parsed.map(point => [point.date, point.value]), [['2026-10-21', 4.4], ['2026-10-22', 5.5], ['2026-10-23', 99]]);
  assert.equal(parsed[1].sourceBucketEndAt, '2026-10-23T00:00:00.000000Z');
  const { patch } = await collectNebius(empty(), options(current(), data));
  assert.deepEqual(patch.history[0].points.map(point => [point.date, point.value]), [['2026-10-21', 4.4], ['2026-10-22', 5.5], ['2026-10-23', 2.15]]);
  assert.equal(patch.history[0].points.at(-1).kind, 'official_api_read');
  assert.match(patch.history[0].description, /2026-10-08.*动态 Spot.*固定 PVM/);
  assert.match(patch.quotes[0].scopeNote, /2026-10-08.*动态 Spot.*固定 PVM/);
});

test('historical currency, identity, duplicate timestamps and malformed timestamps are rejected', () => {
  const products = parseNebiusCurrent(current(), NOW).items;
  const changes = [row => row.currency = 'eur', row => row.unitTitle = 'GPU minute', row => row.region = 'us-east1', row => row.skuId = 'sku-unknown', row => row.points.push(row.points[0]), row => row.points[0].timestamp = '2026-02-30T02:00:00Z'];
  for (const change of changes) { const data = historyFor(); change(data.items[0]); assert.throws(() => parseNebiusHistory(data, products, NOW)); }
});

test('backfill explicitly requests hourly LAST_PRICE, retains missing days, and current observation wins today', async () => {
  const urls = [], config = options(), fetcher = config.fetch;
  config.fetch = async url => { urls.push(new URL(url)); return fetcher(url); };
  const { patch } = await collectNebius(empty(), config);
  assert.equal(urls.length, 2);
  const request = urls[1];
  assert.equal(request.searchParams.get('aggregation.method'), 'METHOD_LAST_PRICE');
  assert.equal(request.searchParams.get('aggregation.granularity'), 'GRANULARITY_HOUR_1');
  assert.equal(request.searchParams.getAll('filters.skuIds').length, 12);
  assert.equal(request.searchParams.get('filters.endTime'), NOW);
  assert.equal(patch.history[0].points.length, 3);
  assert.equal(patch.history[0].points.at(-1).value, 2.15);
  assert.equal(patch.history[0].points.some(point => point.date === '2026-10-20'), false);
});

test('same-day reruns are idempotent and backfill cannot rewrite collected prior days or current day', async () => {
  const first = await collectNebius(empty(), options());
  const before = mergeSnapshot(empty(), first.patch), secondHistory = historyFor();
  secondHistory.items.forEach(row => row.points.forEach(point => point.value = '77'));
  const second = await collectNebius(before, options(current(), secondHistory, '2026-10-23T04:00:00.000Z'));
  const after = mergeSnapshot(before, second.patch);
  assert.equal(after.quotes.length, 12);
  assert.equal(after.history[0].points.length, 3);
  assert.deepEqual(after.history[0].points.slice(0, -1), before.history[0].points.slice(0, -1));
  assert.equal(after.history[0].points.at(-1).value, 2.15);
  assert.equal(second.patch.history[0].points.length, 1);
  assert.ok(after.quotes.every(row => row.observedAt === '2026-10-23T04:00:00.000Z'));
});

test('missing historical day can be backfilled without replacing an existing day', async () => {
  const first = await collectNebius(empty(), options()), old = mergeSnapshot(empty(), first.patch);
  const missingDate = '2026-10-21'; old.history[0].points = old.history[0].points.filter(point => point.date !== missingDate);
  const result = await collectNebius(old, options());
  assert.deepEqual(result.patch.history[0].points.map(point => point.date), [missingDate, '2026-10-23']);
});

test('current pagination is followed and repeated page tokens or keys fail atomically', async () => {
  const data = current(), urls = [];
  const config = { now: () => new Date(NOW), nebiusHistory: false, fetch: async url => {
    urls.push(new URL(url));
    return response(urls.length === 1 ? { ...data, items: data.items.slice(0, 6), nextPageToken: 'next+page' } : { ...data, items: data.items.slice(6) });
  } };
  const good = await collectNebius(empty(), config);
  assert.equal(good.patch.quotes.length, 12);
  assert.equal(urls[1].searchParams.get('pageToken'), 'next+page');
  const bad = await collectNebius(empty(), { ...config, fetch: async () => response({ ...data, nextPageToken: 'same' }) });
  assert.deepEqual(bad.patch, {});
  assert.ok(bad.results.every(row => !row.latestDate));
});

test('history pagination carries all products; failure on a later history page preserves current and drops partial history', async () => {
  const data = historyFor(); let calls = 0;
  const fetch = async url => {
    if (!new URL(url).pathname.endsWith('list-series')) return response(current());
    calls++;
    return response(calls === 1 ? { ...data, items: data.items.slice(0, 6), nextPageToken: 'next' } : { ...data, items: data.items.slice(6) });
  };
  const good = await collectNebius(empty(), { now: () => new Date(NOW), fetch });
  assert.equal(calls, 2);
  assert.ok(good.patch.history.every(row => row.points.length === 3));
  const failed = await collectNebius(empty(), { now: () => new Date(NOW), fetch: async url => {
    const request = new URL(url);
    if (!request.pathname.endsWith('list-series')) return response(current());
    if (request.searchParams.has('pageToken')) return new Response('unavailable', { status: 503 });
    return response({ ...data, items: data.items.slice(0, 6), nextPageToken: 'next' });
  } });
  assert.equal(failed.patch.quotes.length, 12);
  assert.ok(failed.patch.history.every(row => row.points.length === 1));
  assert.ok(failed.results.some(row => row.status === 'warning'));
});

test('HTTP, JSON, content-type, host redirect and timeout failures do not append any date', async () => {
  const failures = [
    async () => new Response('forbidden', { status: 403 }),
    async () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    async () => new Response('{bad', { headers: { 'content-type': 'application/json' } }),
    async () => { const res = response(current()); Object.defineProperty(res, 'url', { value: 'https://example.com/fake' }); return res; },
    async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })),
  ];
  for (const fetch of failures) {
    const result = await collectNebius(empty(), { now: () => new Date(NOW), timeoutMs: 5, fetch });
    assert.deepEqual(result.patch, {});
    assert.ok(result.results.every(row => row.status === 'error' && !row.latestDate));
  }
});

test('source metadata conflicts and newer records remain untouched while other products continue', async () => {
  const first = await collectNebius(empty(), options()), old = mergeSnapshot(empty(), first.patch);
  old.quotes[0].unit = 'instance_hour';
  old.history[1].platform = 'gpu-b200-sxm';
  old.quotes[2].observedAt = '2026-10-24T00:00:00Z';
  const result = await collectNebius(old, options());
  assert.equal(result.patch.quotes.length, 9);
  assert.equal(result.results.filter(row => row.status === 'error').length, 2);
  assert.equal(result.results.filter(row => row.status === 'warning').length, 1);
  const merged = mergeSnapshot(old, result.patch);
  assert.deepEqual(merged.quotes.slice(0, 3), old.quotes.slice(0, 3));
});

test('second daily run accepts legacy public projections without platform/SKU and restores complete metadata', async () => {
  const first = await collectNebius(empty(), options()), projected = mergeSnapshot(empty(), first.patch);
  for (const row of [...projected.quotes, ...projected.history]) {
    delete row.platform; delete row.skuId; delete row.productTitle;
  }
  const next = current(); next.snapshotTime = '2026-10-24T02:00:00.123456Z';
  const result = await collectNebius(projected, { ...options(next, historyFor(next), '2026-10-24T03:00:00.000Z'), nebiusHistory: false });
  assert.equal(result.patch.quotes.length, 12);
  assert.ok(result.results.every(row => row.status === 'success'));
  assert.ok(result.patch.quotes.every(row => row.platform && row.skuId && row.productTitle));
  assert.ok(result.patch.history.every(row => row.platform && row.skuId && row.productTitle));
  const merged = mergeSnapshot(projected, result.patch);
  assert.equal(merged.quotes.length, 24);
  assert.ok(result.patch.quotes.every(row => row.previousDate === '2026-10-23'));
  assert.equal(merged.history[0].points.at(-1).date, '2026-10-24');
  assert.deepEqual(merged.history[0].points.slice(0, -1), projected.history[0].points);
});

test('legacy public projection still requires exact series key and rejects present conflicting SKU/platform', async () => {
  const first = await collectNebius(empty(), options()), old = mergeSnapshot(empty(), first.patch);
  for (const row of [...old.quotes, ...old.history]) { delete row.platform; delete row.skuId; }
  old.history[0].seriesKey = 'nebius-wrong-platform-region-spot';
  old.quotes[1].skuId = 'sku-wrong';
  old.history[2].platform = 'gpu-wrong';
  const result = await collectNebius(old, { ...options(), nebiusHistory: false });
  assert.equal(result.patch.quotes.length, 9);
  assert.equal(result.results.filter(row => row.status === 'error').length, 3);
  assert.equal(result.patch.quotes.some(row => [old.quotes[0].seriesKey, old.quotes[1].seriesKey, old.quotes[2].seriesKey].includes(row.seriesKey)), false);
});

test('continuous 29 prior UTC days avoid unnecessary historical reads', async () => {
  const first = await collectNebius(empty(), { ...options(), nebiusHistory: false }), old = mergeSnapshot(empty(), first.patch);
  old.history.forEach(row => row.points.push(...Array.from({ length: 29 }, (_, i) => ({ date: new Date(Date.parse('2026-10-23T00:00:00Z') - (i + 1) * 86400000).toISOString().slice(0, 10), value: 2 }))));
  let calls = 0;
  const result = await collectNebius(old, { ...options(), fetch: async url => { calls++; assert.equal(new URL(url).pathname, new URL(NEBIUS_API).pathname); return response(current()); } });
  assert.equal(calls, 1);
  assert.equal(result.patch.quotes.length, 12);
});
