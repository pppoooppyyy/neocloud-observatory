import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDaily, SNAPSHOT_URL, UPDATE_URL } from '../scripts/collect-daily.mjs';

const NOW = '2026-10-15T02:00:00Z';
const TOKEN = 'test-only-monitor-token';
function seed() {
  return { version: 1, revision: 7, updatedAt: '2026-10-14T02:00:00Z',
    schedule: { time: '10:00', timezone: 'Asia/Taipei', enabled: true },
    sources: [{ id: 'official', name: 'Public source', url: 'https://example.com/pricing', kind: 'official' }],
    series: [{ id: 'gpu', label: 'GPU', provider: 'Example', model: 'H100', unit: 'usd_per_gpu_hour', region: 'global', market: 'index', aggregation: 'mean', sourceId: 'official', points: [{ date: '2026-10-14', value: 2 }] }],
    quotes: [], deals: [], bonds: [], events: [], history: [], runs: [],
  };
}
function observations() {
  return { patch: { series: [{ ...seed().series[0], points: [{ date: '2026-10-14', value: 3 }, { date: '2026-10-15', value: 4 }] }] }, results: [{ source: 'Example', dataset: 'gpu', status: 'success', latestDate: '2026-10-15', detail: 'Observed current value' }] };
}
function response(status = 'success', revision = 8) {
  return Response.json({ status, revision, summary: 'Saved public observations' });
}
const baseOptions = { token: TOKEN, now: () => new Date(NOW), collector: async () => observations() };

test('submits expected revision and dates, sends token only to the fixed update endpoint', async () => {
  const calls = [];
  const report = await runDaily({ ...baseOptions, fetcher: async (url, options) => {
    calls.push({ url, options });
    return url === SNAPSHOT_URL ? Response.json(seed()) : response();
  } });
  assert.equal(report.status, 'success');
  assert.equal(report.revision, 8);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].url, UPDATE_URL);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[1].options.redirect, 'error');
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(Object.keys(body), ['expectedRevision', 'patch', 'results', 'startedAt']);
  assert.equal(body.expectedRevision, 7);
  assert.equal(body.startedAt, new Date(NOW).toISOString());
  assert.equal(JSON.stringify(report).includes(TOKEN), false);
});

test('409 rebases against the latest snapshot and protects concurrent analyst corrections', async () => {
  const revised = seed(); revised.revision = 8; revised.series[0].points[0].value = 99;
  const posts = []; let reads = 0, collects = 0;
  const report = await runDaily({ ...baseOptions, collector: async () => { collects++; return observations(); }, fetcher: async (url, options) => {
    if (url === SNAPSHOT_URL) return Response.json(++reads === 1 ? seed() : revised);
    posts.push(JSON.parse(options.body));
    return posts.length === 1 ? Response.json({ error: 'conflict' }, { status: 409 }) : response('success', 9);
  } });
  assert.equal(collects, 1);
  assert.equal(reads, 2);
  assert.equal(report.retries, 1);
  assert.equal(posts[1].expectedRevision, 8);
  assert.deepEqual(posts[1].patch.series[0].points, [{ date: '2026-10-15', value: 4 }]);
});

test('three conflict retries are bounded and never recollect', async () => {
  let posts = 0, reads = 0, collects = 0;
  await assert.rejects(runDaily({ ...baseOptions, collector: async () => { collects++; return observations(); }, fetcher: async url => {
    if (url === SNAPSHOT_URL) { const data = seed(); data.revision += reads++; return Response.json(data); }
    posts++; return Response.json({}, { status: 409 });
  } }), /3 次重试/);
  assert.equal(posts, 4);
  assert.equal(reads, 4);
  assert.equal(collects, 1);
});

test('HTTP 200 partial status is accepted and preserves per-source failures', async () => {
  const collected = observations(); collected.results.push({ source: 'Unavailable', status: 'error', detail: 'HTTP 403; prior date retained' });
  const report = await runDaily({ ...baseOptions, collector: async () => collected, fetcher: async url => url === SNAPSHOT_URL ? Response.json(seed()) : response('partial') });
  assert.equal(report.status, 'partial');
  assert.equal(report.results[1].status, 'error');
});

test('missing secret stops before any network or collection work', async () => {
  let calls = 0;
  await assert.rejects(runDaily({ ...baseOptions, token: '', fetcher: async () => { calls++; } }), /NEOCLOUD_SYNC_TOKEN/);
  assert.equal(calls, 0);
});

test('non-409 failure does not retry or expose the server response body', async () => {
  let posts = 0;
  await assert.rejects(runDaily({ ...baseOptions, fetcher: async url => {
    if (url === SNAPSHOT_URL) return Response.json(seed());
    posts++; return Response.json({ error: `do not print ${TOKEN}` }, { status: 401 });
  } }), error => error.message.includes('HTTP 401') && !error.message.includes(TOKEN));
  assert.equal(posts, 1);
});

test('invalid snapshot and invalid collected fields are rejected before writing', async () => {
  let posts = 0;
  const fetcher = async url => { if (url === SNAPSHOT_URL) return Response.json(seed()); posts++; return response(); };
  await assert.rejects(runDaily({ ...baseOptions, collector: async () => ({ patch: { schedule: { enabled: false } }, results: [] }), fetcher }), /不允许/);
  assert.equal(posts, 0);
  await assert.rejects(runDaily({ ...baseOptions, fetcher: async () => Response.json({ revision: 7, sources: [] }) }), /必要数据数组/);
});

test('unconfirmed HTTP 200 response cannot be reported as a saved revision', async () => {
  await assert.rejects(runDaily({ ...baseOptions, fetcher: async url => url === SNAPSHOT_URL ? Response.json(seed()) : response('success', 7) }), /未确认新的快照修订/);
});
