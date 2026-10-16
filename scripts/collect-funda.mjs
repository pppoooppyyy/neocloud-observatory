import { appendFile, readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const CAPTURE_URL = new URL('../collector/funda-capture.json', import.meta.url);
export const SNAPSHOT_URL = 'https://neocloud-sync.poppy9654.workers.dev/api/neocloud/public-snapshot';
export const UPDATE_URL = 'https://neocloud-sync.poppy9654.workers.dev/api/neocloud/collector-update';
export const RESULT_PREFIX = 'NEOCLOUD_FUNDA_RESULT ';
const MAX_BYTES = 4_000_000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const ISSUERS = ['CRWV', 'ORCL', 'SPACEX', 'AVGO', 'META', 'NVDA', 'AMZN', 'GOOGL', 'MSFT'];
const DATA_KEYS = new Set(['schema_version', 'metadata', 'issuers', 'cds_latest', 'cds_history', 'treasury_30y_history', 'capex', 'capex_aggregate_yoy', 'bond_issues', 'events', 'trade_history_partial', 'trade_history_status', 'caveats']);
const ARRAY_KEYS = ['cds_history', 'treasury_30y_history', 'capex', 'capex_aggregate_yoy', 'bond_issues', 'events', 'trade_history_partial'];

function check(condition, message) {
  if (!condition) throw new Error(message);
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const revision = value => Number.isSafeInteger(value) && value >= 0;
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
function utcTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, milliseconds = '') => `.${milliseconds.padEnd(3, '0')}Z`);
  return new Date(parsed).toISOString() === normalized ? parsed : NaN;
}
function httpsUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url : null;
  } catch { return null; }
}
function safeJson(value, depth = 0, budget = { nodes: 0 }) {
  check(depth <= 20 && ++budget.nodes <= 200_000, 'FUNDA 文件结构超过上限');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { check(Number.isFinite(value), 'FUNDA 文件包含非有限数值'); return; }
  if (typeof value === 'string') { check(value.length <= 100_000, 'FUNDA 文件文字超过上限'); return; }
  check(Array.isArray(value) || record(value), 'FUNDA 文件包含非 JSON 值');
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    check(prototype === Object.prototype || prototype === null, 'FUNDA 文件包含非普通对象');
  }
  for (const [key, item] of Object.entries(value)) {
    check(!['__proto__', 'prototype', 'constructor'].includes(key), 'FUNDA 文件包含不安全字段');
    if ((key === 'url' || key.endsWith('_url')) && item !== null) check(httpsUrl(item), 'FUNDA 文件包含无效 HTTPS 来源链接');
    safeJson(item, depth + 1, budget);
  }
}

export function validateCapture(data, timestamp) {
  check(record(data) && data.schema_version === '1.0', 'FUNDA 文件 schema_version 必须为 1.0');
  check(Object.keys(data).every(key => DATA_KEYS.has(key)), 'FUNDA 文件包含不允许的字段或服务器历史记录');
  safeJson(data);
  const meta = data.metadata;
  check(record(meta), 'FUNDA 文件缺少 metadata');
  check(!Object.hasOwn(meta, 'update_mode') && !Object.hasOwn(meta, 'automatic_updates'), 'FUNDA 文件不能修改服务器更新设置');
  const source = httpsUrl(meta.source_url);
  check(source && source.origin === 'https://funda.ai' && source.pathname === '/zh/play/cds' && !source.hash && [...source.searchParams].every(([key, value]) => key === 'ref' && value === 'chat_catalog') && source.searchParams.getAll('ref').length <= 1, 'FUNDA 文件缺少有效的固定来源 URL');
  check(text(meta.page_title) && day(meta.source_as_of), 'FUNDA 文件缺少有效标题或来源日期');
  check(typeof meta.source_generated_at === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(meta.source_generated_at) && Number.isFinite(utcTime(`${meta.source_generated_at.replace(' ', 'T')}:00Z`)), 'FUNDA 来源生成时间无效');
  check(meta.source_generated_timezone === null || text(meta.source_generated_timezone), 'FUNDA 文件缺少来源时区字段');
  const extracted = utcTime(meta.extracted_at);
  check(Number.isFinite(timestamp) && Number.isFinite(extracted), 'FUNDA 实际采集时间无效');
  check(extracted <= timestamp + 60_000, 'FUNDA 实际采集时间位于未来');
  check(timestamp - extracted <= MAX_AGE_MS, 'FUNDA 文件超过 2 小时，请重新通过本机浏览器采集');
  for (const key of ['issuers', 'cds_latest']) {
    check(Array.isArray(data[key]) && data[key].length === ISSUERS.length && data[key].every(record), `FUNDA ${key} 必须包含完整 9 家公司`);
    const ids = data[key].map(row => row.issuer);
    check(new Set(ids).size === ISSUERS.length && ISSUERS.every(id => ids.includes(id)), `FUNDA ${key} 公司列表不完整或重复`);
  }
  for (const quote of data.cds_latest) {
    check(text(quote.issuer_name) && typeof quote.spread_bp === 'number' && quote.spread_bp >= 0 && day(quote.observation_date) && text(quote.quote_source_label), 'FUNDA 最新 CDS 报价字段不完整');
    check(quote.coupon_bp === (quote.issuer === 'CRWV' ? 500 : 100) && quote.tenor_years === 5 && quote.seniority === 'senior_unsecured', 'FUNDA CDS 合约口径无效');
  }
  for (const key of ARRAY_KEYS) check(data[key] === undefined || Array.isArray(data[key]), `FUNDA ${key} 必须为数组`);
  check(data.caveats === undefined || record(data.caveats), 'FUNDA caveats 必须为说明对象');
  check(new TextEncoder().encode(JSON.stringify(data)).byteLength <= MAX_BYTES, 'FUNDA 文件超过 4 MB');
  return data;
}

async function loadCapture() {
  try {
    const info = await stat(CAPTURE_URL);
    check(info.isFile() && info.size <= MAX_BYTES, 'FUNDA 文件超过 4 MB 或不是普通文件');
    const raw = await readFile(CAPTURE_URL, 'utf8');
    check(new TextEncoder().encode(raw).byteLength <= MAX_BYTES, 'FUNDA 文件超过 4 MB');
    try { return JSON.parse(raw); } catch { throw new Error('FUNDA 文件不是有效 JSON'); }
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
async function request(fetcher, url, options) {
  try { return await fetcher(url, options); }
  catch { throw new Error('FUNDA 同步网络请求失败，未确认提交'); }
}
async function readJson(response) {
  check(/application\/json/i.test(response.headers.get('content-type') || ''), '同步接口未返回 JSON，未接受响应');
  check(Number(response.headers.get('content-length') || 0) <= MAX_BYTES && response.body, '同步响应为空或超过大小上限');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, content = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      check(size <= MAX_BYTES, '同步响应超过大小上限');
      content += decoder.decode(value, { stream: true });
    }
    try { return JSON.parse(content + decoder.decode()); } catch { throw new Error('同步接口返回无效 JSON，未确认提交'); }
  } finally { await reader.cancel().catch(() => {}); }
}
async function readRevision(fetcher) {
  const response = await request(fetcher, SNAPSHOT_URL, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(25_000),
  });
  check(response.ok, `读取公开快照失败：HTTP ${response.status}`);
  const snapshot = await readJson(response);
  check(record(snapshot) && revision(snapshot.revision), '公开快照 revision 无效');
  return snapshot.revision;
}

/** Submit only the fixed browser capture. Daily GPU/financing data are never collected or patched here. */
export async function runFunda({ fetcher = fetch, readCapture = loadCapture, token = process.env.NEOCLOUD_SYNC_TOKEN, now = () => new Date(), maxRetries = 3 } = {}) {
  let capture;
  try { capture = await readCapture(); }
  catch { throw new Error('无法读取有效的固定 FUNDA 采集文件'); }
  if (capture === null) return { status: 'skipped', summary: '尚无 collector/funda-capture.json；等待本机 Chrome 采集后推送。' };
  check(typeof token === 'string' && token.trim().length > 0 && !/[\r\n]/.test(token), '请先配置仓库 Secret NEOCLOUD_SYNC_TOKEN');
  check(Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 3, '重试次数须介于 0 和 3');
  const timestamp = now();
  check(timestamp instanceof Date && Number.isFinite(timestamp.getTime()), '同步开始时间无效');
  validateCapture(capture, timestamp.getTime());
  // Freeze the submitted observations before any request or conflict retry.
  const data = JSON.parse(JSON.stringify(capture));
  data.metadata.source_url = 'https://funda.ai/zh/play/cds';
  const startedAt = timestamp.toISOString();
  let expectedRevision = await readRevision(fetcher);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    validateCapture(data, now().getTime());
    const body = JSON.stringify({ expectedRevision, startedAt, creditCapture: { provider: 'funda', schemaVersion: 1, data } });
    check(new TextEncoder().encode(body).byteLength <= MAX_BYTES, 'FUNDA 提交超过 4 MB');
    const response = await request(fetcher, UPDATE_URL, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body,
    });
    if (response.status === 409) {
      await response.body?.cancel();
      check(attempt < maxRetries, '快照连续发生并发修改，3 次重试后停止；未覆盖较新记录');
      expectedRevision = await readRevision(fetcher);
      continue;
    }
    check(response.ok, `提交 FUNDA 采集失败：HTTP ${response.status}`);
    const saved = await readJson(response);
    check(record(saved) && saved.ok === true && ['pending', 'published', 'unchanged'].includes(saved.status), '同步接口未明确确认 FUNDA 采集状态');
    check(revision(saved.revision) && saved.revision >= expectedRevision, '同步接口未确认有效快照修订');
    let creditCollectionStatus = null;
    if (record(saved.creditCollectionStatus)) {
      const status = saved.creditCollectionStatus;
      check(status.status === saved.status, '同步接口的信用状态不一致');
      for (const key of ['lastCheckedAt', 'pendingFirstSeenAt', 'lastPublishedAt']) check(status[key] === null || Number.isFinite(utcTime(status[key])), '同步接口的信用状态时间无效');
      check(status.pendingSourceVersion === null || /^[a-f0-9]{64}$/.test(status.pendingSourceVersion), '同步接口的信用版本无效');
      creditCollectionStatus = Object.fromEntries(['status', 'lastCheckedAt', 'pendingFirstSeenAt', 'pendingSourceVersion', 'lastPublishedAt'].map(key => [key, status[key]]));
    }
    return { status: saved.status, revision: saved.revision, retries: attempt, startedAt, sourceAsOf: data.metadata.source_as_of, extractedAt: data.metadata.extracted_at, creditCollectionStatus };
  }
  throw new Error('FUNDA 同步未完成');
}

export async function writeSummary(report, path) {
  if (!path) return;
  const detail = report.status === 'skipped' ? '尚无固定采集文件；等待本机 Chrome 采集后推送。' : `快照修订：${report.revision} · 并发重试：${report.retries}\n\n来源日期：${report.sourceAsOf} · 浏览器实际采集：${report.extractedAt}`;
  await appendFile(path, `## FUNDA 浏览器采集同步\n\n状态：**${report.status}**\n\n${detail}\n\npending 表示等待后续独立采集确认；published 表示服务器已发布；unchanged 保留现有版本。\n`, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runFunda();
    console.log(RESULT_PREFIX + JSON.stringify(report));
    await writeSummary(report, process.env.GITHUB_STEP_SUMMARY);
  } catch (error) {
    const token = process.env.NEOCLOUD_SYNC_TOKEN;
    const message = error instanceof Error ? error.message : 'FUNDA 同步失败';
    console.error(JSON.stringify({ status: 'error', message: token ? message.replaceAll(token, '[REDACTED]') : message }));
    process.exitCode = 1;
  }
}
