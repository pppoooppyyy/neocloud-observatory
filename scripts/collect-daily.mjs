import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { collectDaily } from '../collector/daily-collectors.mjs';
import { concurrentPatch } from '../collector/concurrent-patch.ts';
import { mergeSnapshot, validatePatch, validateReferences } from '../collector/metrics.ts';

export const SNAPSHOT_URL = 'https://research.castoramoney.com/api/neocloud/public-snapshot';
export const UPDATE_URL = 'https://research.castoramoney.com/api/neocloud/collector-update';
const MAX_BYTES = 4_000_000;
const PATCH_KEYS = ['sources', 'series', 'quotes', 'deals', 'bonds', 'events', 'treasury', 'history'];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(response) {
  check(/application\/json/i.test(response.headers.get('content-type') || ''), '同步接口未返回 JSON，未接受响应');
  check(Number(response.headers.get('content-length') || 0) <= MAX_BYTES, '同步响应超过大小上限');
  check(response.body, '同步接口没有响应正文');
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
    return JSON.parse(content + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}

async function readSnapshot(fetcher) {
  const response = await fetcher(SNAPSHOT_URL, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 700);
    throw new Error(`读取公开快照失败：HTTP ${response.status}; ray=${response.headers.get('cf-ray') || ''}; server=${response.headers.get('server') || ''}; ${detail}`);
  }
  const snapshot = await readJson(response);
  check(snapshot && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0, '公开快照 revision 无效');
  check(['sources', 'series', 'quotes', 'deals', 'bonds', 'events', 'runs'].every(key => Array.isArray(snapshot[key])), '公开快照缺少必要数据数组');
  const projected = Object.fromEntries(PATCH_KEYS.filter(key => snapshot[key] !== undefined).map(key => [key, snapshot[key]]));
  const issue = validatePatch(projected) || validateReferences(snapshot);
  check(!issue, `公开快照校验失败：${issue}`);
  return snapshot;
}

/** Token is sent only to the fixed monitor write endpoint; never to public sources. */
export async function runDaily({ fetcher = fetch, collector = collectDaily, token = process.env.NEOCLOUD_SYNC_TOKEN, now = () => new Date(), maxRetries = 3 } = {}) {
  check(typeof token === 'string' && token.trim().length > 0 && !/[\r\n]/.test(token), '请先配置仓库 Secret NEOCLOUD_SYNC_TOKEN');
  check(Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 3, '重试次数须介于 0 和 3');
  const startedAt = now().toISOString();
  const baseline = await readSnapshot(fetcher);
  const collected = await collector(baseline);
  check(collected && collected.patch && Array.isArray(collected.results), '采集器返回格式无效，未提交');
  check(!Object.keys(collected.patch).some(key => !PATCH_KEYS.includes(key)), '采集器包含不允许的更新字段');
  let current = baseline;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Always rebase the original observations against the original baseline.
    // This protects corrections made between collection and any later retry.
    const patch = attempt === 0 ? collected.patch : concurrentPatch(baseline, current, collected.patch);
    const issue = validatePatch(patch) || validateReferences(mergeSnapshot(current, patch));
    check(!issue, `采集增量校验失败：${issue}`);
    const body = JSON.stringify({ expectedRevision: current.revision, patch, results: collected.results, startedAt });
    check(new TextEncoder().encode(body).byteLength <= MAX_BYTES, '采集增量超过 4 MB，未提交');
    const response = await fetcher(UPDATE_URL, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body,
    });
    if (response.status === 409) {
      await response.body?.cancel();
      check(attempt < maxRetries, '快照连续发生并发修改，3 次重试后停止；未覆盖较新记录');
      current = await readSnapshot(fetcher);
      continue;
    }
    check(response.ok, `提交采集结果失败：HTTP ${response.status}`);
    const saved = await readJson(response);
    check(['success', 'partial', 'error'].includes(saved.status), '同步接口缺少采集状态，不能确认写入');
    check(Number.isSafeInteger(saved.revision) && saved.revision > current.revision, '同步接口未确认新的快照修订');
    return {
      startedAt, completedAt: now().toISOString(), status: saved.status, revision: saved.revision,
      retries: attempt, summary: typeof saved.summary === 'string' ? saved.summary : '',
      counts: Object.fromEntries(Object.entries(patch).map(([key, rows]) => [key, rows.length])),
      results: collected.results,
    };
  }
  throw new Error('采集同步未完成');
}

function safe(value, token) {
  const text = String(value ?? '');
  return token ? text.replaceAll(token, '[REDACTED]') : text;
}
function cell(value, token) {
  return safe(value, token).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function writeSummary(report, path, token) {
  if (!path) return;
  const rows = report.results.map(row => `| ${cell(row.dataset || '', token)} | ${cell(row.source, token)} | ${cell(row.status, token)} | ${cell(row.latestDate || '', token)} | ${cell(row.detail || '', token)} |`);
  await appendFile(path, `## Neocloud 每日采集\n\n状态：**${cell(report.status, token)}** · 修订：${report.revision} · 并发重试：${report.retries}\n\n${cell(report.summary, token)}\n\n| 数据组 | 来源 | 结果 | 来源日期 | 说明 |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\nCDS 原图保留；缺失数据及未接入逐券行情保留原日期。\n`, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.NEOCLOUD_SYNC_TOKEN;
  try {
    const report = await runDaily();
    console.log(safe(JSON.stringify(report, null, 2), token));
    await writeSummary(report, process.env.GITHUB_STEP_SUMMARY, token);
    // Partial results are a completed run; total source failure needs attention.
    if (report.status === 'error') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'error', message: safe(error instanceof Error ? error.message : '采集执行失败', token) }));
    process.exitCode = 1;
  }
}
