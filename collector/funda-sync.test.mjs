import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runFunda, validateCapture, CAPTURE_URL, SNAPSHOT_URL, UPDATE_URL } from '../scripts/collect-funda.mjs';

const NOW = '2026-10-16T02:00:00.000Z';
const TOKEN = 'test-only-funda-monitor-token';
const ISSUERS = ['CRWV', 'ORCL', 'SPACEX', 'AVGO', 'META', 'NVDA', 'AMZN', 'GOOGL', 'MSFT'];
function capture() {
  return {
    schema_version: '1.0',
    metadata: { source_url: 'https://funda.ai/zh/play/cds?ref=chat_catalog', source_as_of: '2026-10-15', source_generated_at: '2026-10-16 06:09', source_generated_timezone: null, extracted_at: '2026-10-16T01:55:00.000Z', page_title: 'CDS monitor' },
    issuers: ISSUERS.map(issuer => ({ issuer, english_name: issuer, chinese_name: issuer, coupon_bp: issuer === 'CRWV' ? 500 : 100 })),
    cds_latest: ISSUERS.map(issuer => ({ issuer, issuer_name: issuer, spread_bp: 100, observation_date: '2026-10-15', quote_source_label: issuer === 'SPACEX' ? 'upfront 折算' : 'ICE 结算价', coupon_bp: issuer === 'CRWV' ? 500 : 100, tenor_years: 5, seniority: 'senior_unsecured' })),
    cds_history: [{ issuer: 'CRWV', plot_date: '2026-10-15', spread_bp: null, observation_date: null }],
    caveats: { 日期含义: 'plot_date 为绘图日期' },
  };
}
const options = { token: TOKEN, now: () => new Date(NOW), readCapture: async () => capture() };
const saved = (status = 'published', revision = 8, rest = {}) => Response.json({ ok: true, status, revision, ...rest });
const fetchSuccess = async url => url === SNAPSHOT_URL ? Response.json({ revision: 7 }) : saved();

test('posts only the canonical FUNDA envelope and uses the token only at the fixed update endpoint', async () => {
  const calls = [], input = capture(), before = JSON.stringify(input);
  const result = await runFunda({ ...options, readCapture: async () => input, fetcher: async (url, init) => {
    calls.push({ url, init });
    return fetchSuccess(url);
  } });
  assert.equal(result.status, 'published');
  assert.equal(result.revision, 8);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, SNAPSHOT_URL);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[1].url, UPDATE_URL);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(calls[1].init.credentials, 'omit');
  assert.ok(calls.every(call => call.init.signal instanceof AbortSignal));
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(Object.keys(body), ['expectedRevision', 'startedAt', 'creditCapture']);
  assert.equal(body.expectedRevision, 7);
  assert.equal(body.startedAt, NOW);
  assert.equal(body.creditCapture.provider, 'funda');
  assert.equal(body.creditCapture.schemaVersion, 1);
  assert.equal(body.creditCapture.data.metadata.source_url, 'https://funda.ai/zh/play/cds');
  assert.equal(body.creditCapture.data.cds_history[0].spread_bp, null);
  assert.equal(body.patch, undefined);
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.ok(CAPTURE_URL.pathname.endsWith('/collector/funda-capture.json'));
});

test('no capture file skips successfully without needing a token or making requests', async () => {
  let requests = 0;
  const result = await runFunda({ ...options, token: '', readCapture: async () => null, fetcher: async () => { requests++; } });
  assert.equal(result.status, 'skipped');
  assert.match(result.summary, /等待本机 Chrome/);
  assert.equal(requests, 0);
});

test('missing token and unreadable capture fail before network access without exposing reader errors', async () => {
  let requests = 0;
  const fetcher = async () => { requests++; };
  await assert.rejects(runFunda({ ...options, token: '', fetcher }), /NEOCLOUD_SYNC_TOKEN/);
  await assert.rejects(runFunda({ ...options, fetcher, readCapture: async () => { throw new Error(TOKEN); } }), error => error.message.includes('固定 FUNDA') && !error.message.includes(TOKEN));
  assert.equal(requests, 0);
});

test('two-hour boundary is accepted; older captures never reach the network', async () => {
  const data = capture();
  data.metadata.extracted_at = '2026-10-16T00:00:00.000Z';
  assert.doesNotThrow(() => validateCapture(data, Date.parse(NOW)));
  data.metadata.extracted_at = '2026-10-15T23:59:59.999Z';
  let requests = 0;
  await assert.rejects(runFunda({ ...options, readCapture: async () => data, fetcher: async () => { requests++; } }), /超过 2 小时/);
  assert.equal(requests, 0);
});

test('invalid or future extracted times are rejected; one-minute clock tolerance is bounded', () => {
  for (const invalid of ['2026-02-30T02:00:00.000Z', '2026-10-16 02:00', '2026-10-16T10:00:00+08:00', '2026-10-16T02:01:00.001Z']) {
    const data = capture(); data.metadata.extracted_at = invalid;
    assert.throws(() => validateCapture(data, Date.parse(NOW)), /采集时间/);
  }
  const data = capture(); data.metadata.extracted_at = '2026-10-16T02:01:00.000Z';
  assert.doesNotThrow(() => validateCapture(data, Date.parse(NOW)));
});

test('unsafe numbers, links, object keys, and server-owned histories are refused', () => {
  const changes = [
    data => { data.cds_latest[0].spread_bp = Infinity; },
    data => { data.cds_latest[0].spread_bp = NaN; },
    data => { data.metadata.source_url = 'https://funda.ai/zh/play/cds?token=secret'; },
    data => { data.metadata.source_url = 'https://funda.ai.evil.test/zh/play/cds'; },
    data => { data.events = [{ source_url: 'javascript:alert(1)' }]; },
    data => { data.events = [{ source_url: 'https://user:password@example.com' }]; },
    data => { data.events = [JSON.parse('{"__proto__":{"polluted":true}}')]; },
    data => { data.observations = []; },
    data => { data.corrections = []; },
    data => { data.captures = []; },
    data => { data.metadata.update_mode = 'anything'; },
    data => { data.metadata.automatic_updates = true; },
  ];
  for (const change of changes) { const data = capture(); change(data); assert.throws(() => validateCapture(data, Date.parse(NOW))); }
});

test('capture requires nine distinct issuers and valid latest contract/date metadata', () => {
  const changes = [
    data => { data.issuers.pop(); },
    data => { data.cds_latest[1].issuer = 'CRWV'; },
    data => { data.cds_latest[0].observation_date = '2026-02-30'; },
    data => { data.cds_latest[0].tenor_years = 10; },
    data => { data.cds_latest[0].quote_source_label = ''; },
    data => { delete data.metadata.source_generated_timezone; },
    data => { data.metadata.source_generated_at = '2026-10-16 25:00'; },
  ];
  for (const change of changes) { const data = capture(); change(data); assert.throws(() => validateCapture(data, Date.parse(NOW))); }
});

test('409 rereads only the revision and replays the exact original capture without recollecting', async () => {
  const posts = []; let reads = 0, captures = 0;
  const result = await runFunda({ ...options, readCapture: async () => { captures++; return capture(); }, fetcher: async (url, init) => {
    if (url === SNAPSHOT_URL) return Response.json({ revision: ++reads === 1 ? 7 : 12, creditMonitor: { deliberately: 'newer data must not be copied into capture' } });
    posts.push(JSON.parse(init.body));
    return posts.length === 1 ? Response.json({}, { status: 409 }) : saved('pending', 12);
  } });
  assert.equal(result.retries, 1);
  assert.equal(captures, 1);
  assert.equal(reads, 2);
  assert.equal(posts[1].expectedRevision, 12);
  assert.deepEqual(posts[1].creditCapture, posts[0].creditCapture);
  assert.equal(posts[1].startedAt, posts[0].startedAt);
});

test('three conflict retries are bounded to four attempts', async () => {
  let posts = 0, reads = 0;
  await assert.rejects(runFunda({ ...options, fetcher: async url => {
    if (url === SNAPSHOT_URL) return Response.json({ revision: 7 + reads++ });
    posts++; return Response.json({}, { status: 409 });
  } }), /3 次重试/);
  assert.equal(posts, 4); assert.equal(reads, 4);
});

test('pending and unchanged explicitly acknowledged no-op revisions are accepted', async () => {
  for (const status of ['pending', 'unchanged']) {
    const result = await runFunda({ ...options, fetcher: async url => url === SNAPSHOT_URL ? Response.json({ revision: 7 }) : saved(status, 7, { committed: false }) });
    assert.equal(result.status, status); assert.equal(result.revision, 7);
  }
});

test('HTTP success alone, unknown status, or missing/stale revision never confirms submission', async () => {
  for (const body of [{ status: 'published', revision: 8 }, { ok: false, status: 'published', revision: 8 }, { ok: true, status: 'success', revision: 8 }, { ok: true, status: 'published' }, { ok: true, status: 'unchanged', revision: 6 }, { ok: true, status: 'pending', revision: 7.5 }]) {
    await assert.rejects(runFunda({ ...options, fetcher: async url => url === SNAPSHOT_URL ? Response.json({ revision: 7 }) : Response.json(body) }), /未明确确认|未确认有效/);
  }
});

test('non-409 failure is not retried and never exposes response or network error contents', async () => {
  let posts = 0;
  await assert.rejects(runFunda({ ...options, fetcher: async url => {
    if (url === SNAPSHOT_URL) return Response.json({ revision: 7 });
    posts++; return Response.json({ error: TOKEN }, { status: 403 });
  } }), error => /HTTP 403/.test(error.message) && !error.message.includes(TOKEN));
  assert.equal(posts, 1);
  await assert.rejects(runFunda({ ...options, fetcher: async () => { throw new Error(TOKEN); } }), error => /网络请求失败/.test(error.message) && !error.message.includes(TOKEN));
});

test('invalid public revision and malformed/oversized API JSON are rejected', async () => {
  await assert.rejects(runFunda({ ...options, fetcher: async () => Response.json({ revision: -1 }) }), /revision 无效/);
  await assert.rejects(runFunda({ ...options, fetcher: async () => new Response(TOKEN, { headers: { 'Content-Type': 'application/json' } }) }), error => /无效 JSON/.test(error.message) && !error.message.includes(TOKEN));
  await assert.rejects(runFunda({ ...options, fetcher: async () => Response.json({ revision: 7 }, { headers: { 'Content-Length': '4000001' } }) }), /大小上限/);
  await assert.rejects(runFunda({ ...options, fetcher: async () => new Response('<html>challenge</html>', { headers: { 'Content-Type': 'text/html' } }) }), /未返回 JSON/);
});

test('workflow is dispatch/push only, read-only, fixed-path, and shares the daily concurrency lock', async () => {
  const workflow = await readFile(new URL('../.github/workflows/neocloud-funda.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.equal(/^\s*schedule:/m.test(workflow), false);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.equal(/contents: write/.test(workflow), false);
  assert.match(workflow, /group: neocloud-daily-collection/);
  assert.match(workflow, /cancel-in-progress: false/);
  const paths = [...workflow.matchAll(/^      - '([^']+)'$/gm)].map(match => match[1]);
  assert.deepEqual(paths, ['collector/funda-capture.json', 'scripts/collect-funda.mjs', 'collector/funda-sync.test.mjs', '.github/workflows/neocloud-funda.yml']);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /secrets\.NEOCLOUD_SYNC_TOKEN/);
  assert.equal((workflow.match(/secrets\./g) || []).length, 1);
  assert.equal(/collect-daily|CLOUDFLARE|npm install/.test(workflow), false);
});
