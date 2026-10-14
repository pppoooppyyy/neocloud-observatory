import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { maintainSchedule, REPOSITORY, HEARTBEAT_PATH, HEARTBEAT_URL, INTERVAL_DAYS } from '../scripts/maintain-schedule.mjs';

const NOW = '2026-10-14T02:00:00.000Z';
const TOKEN = 'fictional-maintenance-test-token';
const SHA = 'a'.repeat(40), NEW_SHA = 'b'.repeat(40), COMMIT = 'c'.repeat(40);
const DAY = 86_400_000;
const isoBefore = milliseconds => new Date(Date.parse(NOW) - milliseconds).toISOString();
const config = { token: TOKEN, repository: REPOSITORY, ref: 'refs/heads/main', runId: '123456', now: () => new Date(NOW) };
function blob(checkedAt, sha = SHA, raw) {
  return Response.json({ type: 'file', encoding: 'base64', sha, content: Buffer.from(raw ?? JSON.stringify({ checkedAt })).toString('base64') });
}
function confirmed() {
  return Response.json({ commit: { sha: COMMIT }, content: { path: HEARTBEAT_PATH } }, { status: 201 });
}
function mock(responses) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.ok(responses.length, 'Unexpected extra API request');
    const next = responses.shift();
    return typeof next === 'function' ? next(url, options) : next;
  };
  return { calls, fetcher, remaining: () => responses.length };
}
const invoke = (fixture, overrides = {}) => maintainSchedule({ ...config, fetcher: fixture.fetcher, ...overrides });

test('first maintenance creates only the fixed heartbeat file on main, with no SHA or secret in content', async () => {
  const f = mock([Response.json({ message: 'not found' }, { status: 404 }), confirmed()]);
  const result = await invoke(f);
  assert.equal(result.status, 'updated');
  assert.equal(result.commit, COMMIT);
  assert.equal(result.checkedAt, NOW);
  assert.equal(result.nextDueAt, new Date(Date.parse(NOW) + 20 * DAY).toISOString());
  assert.deepEqual(f.calls.map(row => row.url), [HEARTBEAT_URL + '?ref=main', HEARTBEAT_URL]);
  assert.equal(f.calls[1].options.method, 'PUT');
  for (const call of f.calls) {
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, `Bearer ${TOKEN}`);
  }
  const request = JSON.parse(f.calls[1].options.body);
  assert.equal(request.branch, 'main');
  assert.equal(Object.hasOwn(request, 'sha'), false);
  const heartbeat = JSON.parse(Buffer.from(request.content, 'base64').toString('utf8'));
  assert.equal(heartbeat.checkedAt, NOW);
  assert.equal(heartbeat.intervalDays, INTERVAL_DAYS);
  assert.equal(heartbeat.runUrl, `https://github.com/${REPOSITORY}/actions/runs/123456`);
  assert.equal(heartbeat.workflow, '.github/workflows/neocloud-daily.yml');
  assert.equal(JSON.stringify(heartbeat).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('before the exact 20-day boundary no write occurs; at the boundary it updates using the current SHA', async () => {
  for (const age of [0, 19 * DAY, 20 * DAY - 1]) {
    const f = mock([blob(isoBefore(age))]);
    const result = await invoke(f);
    assert.equal(result.status, 'current');
    assert.equal(f.calls.length, 1);
    assert.equal(result.checkedAt, isoBefore(age));
  }
  for (const age of [20 * DAY, 20 * DAY + 1, 80 * DAY]) {
    const f = mock([blob(isoBefore(age)), confirmed()]);
    assert.equal((await invoke(f)).status, 'updated');
    assert.equal(JSON.parse(f.calls[1].options.body).sha, SHA);
  }
});

test('wrong repository or branch, missing/invalid token and missing run ID stop before network', async () => {
  for (const override of [
    { repository: 'someone-else/neocloud-observatory' }, { ref: 'refs/heads/feature' }, { ref: 'refs/pull/1/merge' },
    { token: '' }, { token: 'bad\ntoken' }, { runId: '' }, { runId: '123/not-a-run' },
    { now: () => new Date('invalid') },
  ]) {
    const f = mock([]);
    await assert.rejects(invoke(f, override));
    assert.equal(f.calls.length, 0);
  }
});

test('invalid, missing, malformed and future saved timestamps are repaired with the known blob SHA', async () => {
  for (const response of [
    blob('not-a-date'), blob(undefined), blob(null), blob('2026-10-15T02:00:00Z'), blob(null, SHA, '{broken json'),
  ]) {
    const f = mock([response, confirmed()]);
    const result = await invoke(f);
    assert.equal(result.status, 'updated');
    const request = JSON.parse(f.calls[1].options.body);
    assert.equal(request.sha, SHA);
    assert.equal(JSON.parse(Buffer.from(request.content, 'base64').toString('utf8')).checkedAt, NOW);
  }
});

test('409 re-read sees fresh concurrent maintenance and returns current without overwriting it', async () => {
  const fresh = isoBefore(DAY);
  const f = mock([blob(isoBefore(30 * DAY)), Response.json({}, { status: 409 }), blob(fresh, NEW_SHA)]);
  const result = await invoke(f);
  assert.equal(result.status, 'current');
  assert.equal(result.checkedAt, fresh);
  assert.equal(f.calls.filter(call => call.options.method === 'PUT').length, 1);
  assert.equal(f.calls.length, 3);
});

test('409 re-read of another stale blob uses its new SHA rather than blindly retrying the old one', async () => {
  const f = mock([blob(isoBefore(30 * DAY)), Response.json({}, { status: 409 }), blob(isoBefore(25 * DAY), NEW_SHA), confirmed()]);
  const result = await invoke(f);
  assert.equal(result.status, 'updated');
  const puts = f.calls.filter(call => call.options.method === 'PUT');
  assert.deepEqual(puts.map(call => JSON.parse(call.options.body).sha), [SHA, NEW_SHA]);
});

test('conflicts are bounded to three read/write attempts', async () => {
  const responses = Array.from({ length: 3 }, (_, index) => [blob(isoBefore(30 * DAY), String(index + 1).repeat(40)), Response.json({}, { status: 409 })]).flat();
  const f = mock(responses);
  await assert.rejects(invoke(f), /concurrently three times/);
  assert.equal(f.calls.length, 6);
  assert.equal(f.remaining(), 0);
});

test('non-409 read and write errors do not retry or expose server error bodies', async () => {
  for (const status of [401, 403, 422, 500, 503]) {
    for (const stage of ['read', 'write']) {
      const failure = Response.json({ message: `Do not expose ${TOKEN}` }, { status });
      const f = mock(stage === 'read' ? [failure] : [blob(isoBefore(30 * DAY)), failure]);
      await assert.rejects(invoke(f), error => error.message.includes(`HTTP ${status}`) && !error.message.includes(TOKEN));
      assert.equal(f.calls.length, stage === 'read' ? 1 : 2);
    }
  }
});

test('unconfirmed or wrong-file success responses cannot be reported as an update', async () => {
  for (const result of [{}, { commit: { sha: 'bad-sha' }, content: { path: HEARTBEAT_PATH } }, { commit: { sha: COMMIT }, content: { path: 'README.md' } }]) {
    const f = mock([blob(isoBefore(30 * DAY)), Response.json(result)]);
    await assert.rejects(invoke(f), /did not confirm/);
    assert.equal(f.calls.length, 2);
  }
});

test('unexpected repository content metadata is rejected instead of replaced', async () => {
  for (const metadata of [
    { type: 'dir', encoding: 'base64', sha: SHA, content: '' },
    { type: 'file', encoding: 'utf-8', sha: SHA, content: '{}' },
    { type: 'file', encoding: 'base64', sha: 'invalid', content: '' },
  ]) {
    const f = mock([Response.json(metadata)]);
    await assert.rejects(invoke(f), /Unexpected heartbeat file response/);
    assert.equal(f.calls.length, 1);
  }
});

test('CLI redacts a token even when an underlying thrown error contains it', async () => {
  const script = new URL('../scripts/maintain-schedule.mjs', import.meta.url);
  const code = `globalThis.fetch=async()=>{throw new Error('transport error '+process.env.GITHUB_TOKEN)};process.argv[1]=${JSON.stringify(fileURLToPath(script))};await import(${JSON.stringify(script.href)});`;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], {
    env: { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '123456' },
  }), error => error.code === 1 && error.stderr.includes('[REDACTED]') && !error.stderr.includes(TOKEN) && !error.stdout.includes(TOKEN));
});

test('maintenance job is independent and alone has write permission; collection keeps read permission and its own secret', async () => {
  const workflow = await readFile(new URL('../.github/workflows/neocloud-daily.yml', import.meta.url), 'utf8');
  const maintenance = /^  maintain-schedule:\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/m.exec(workflow)?.[1];
  const collect = /^  collect:\n([\s\S]*)/m.exec(workflow)?.[1];
  assert.ok(maintenance && collect, 'Both jobs must exist');
  assert.match(workflow, /^permissions:\n  contents: read\s*$/m);
  assert.match(maintenance, /^    permissions:\n      contents: write\s*$/m);
  assert.equal((workflow.match(/\bcontents:\s*write\b/g) || []).length, 1);
  assert.doesNotMatch(maintenance, /^    needs:/m, 'Maintenance must not depend on collection');
  assert.doesNotMatch(maintenance, /NEOCLOUD_SYNC_TOKEN|secrets\./);
  assert.match(maintenance, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.doesNotMatch(collect, /^    permissions:/m, 'Collection must inherit top-level read permission');
  assert.match(collect, /NEOCLOUD_SYNC_TOKEN:\s*\$\{\{ secrets\.NEOCLOUD_SYNC_TOKEN \}\}/);
  assert.match(maintenance, /node scripts\/maintain-schedule\.mjs/);
  assert.doesNotMatch(maintenance, /scripts\/collect-daily\.mjs/);
});
