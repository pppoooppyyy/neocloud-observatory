import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'pppoooppyyy/neocloud-observatory';
export const HEARTBEAT_PATH = '.github/schedule-heartbeat.json';
export const HEARTBEAT_URL = `https://api.github.com/repos/${REPOSITORY}/contents/${HEARTBEAT_PATH}`;
export const INTERVAL_DAYS = 20;
const INTERVAL_MS = INTERVAL_DAYS * 24 * 60 * 60 * 1000;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

// A genuine file commit keeps repository activity well inside GitHub's 60-day
// inactivity window. This job has no access to the Portal collection secret.
export async function maintainSchedule({
  fetcher = fetch, token = process.env.GITHUB_TOKEN,
  repository = process.env.GITHUB_REPOSITORY, ref = process.env.GITHUB_REF,
  runId = process.env.GITHUB_RUN_ID, now = () => new Date(),
} = {}) {
  check(repository === REPOSITORY && ref === 'refs/heads/main', 'Maintenance is restricted to the production repository main branch');
  check(typeof token === 'string' && token.length > 0 && !/[\r\n]/.test(token), 'GITHUB_TOKEN is required');
  check(/^\d+$/.test(String(runId || '')), 'A GitHub Actions run ID is required');
  const timestamp = now();
  check(Number.isFinite(timestamp.getTime()), 'Invalid maintenance time');
  const headers = {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
  };
  const request = (url, options = {}) => fetcher(url, {
    ...options, headers, redirect: 'error', signal: AbortSignal.timeout(25_000),
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request(`${HEARTBEAT_URL}?ref=main`);
    check(response.ok || response.status === 404, `Cannot read schedule heartbeat: HTTP ${response.status}`);
    let sha, lastAt;
    if (response.ok) {
      const file = await response.json();
      check(file.type === 'file' && file.encoding === 'base64' && typeof file.content === 'string' && /^[a-f0-9]{40}$/.test(file.sha), 'Unexpected heartbeat file response');
      sha = file.sha;
      try {
        const saved = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
        lastAt = typeof saved.checkedAt === 'string' ? Date.parse(saved.checkedAt) : NaN;
      } catch { lastAt = NaN; }
    } else {
      await response.body?.cancel();
    }
    const age = timestamp.getTime() - lastAt;
    // Invalid/future timestamps are repaired instead of suppressing maintenance.
    if (Number.isFinite(age) && age >= 0 && age < INTERVAL_MS) {
      return { status: 'current', checkedAt: new Date(lastAt).toISOString(), nextDueAt: new Date(lastAt + INTERVAL_MS).toISOString() };
    }

    const heartbeat = {
      version: 1,
      purpose: 'Keep the daily public-data schedule active through repository activity',
      checkedAt: timestamp.toISOString(), intervalDays: INTERVAL_DAYS,
      workflow: '.github/workflows/neocloud-daily.yml',
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    };
    const saved = await request(HEARTBEAT_URL, {
      method: 'PUT', body: JSON.stringify({
        message: 'chore: record scheduled maintenance activity', branch: 'main',
        content: Buffer.from(`${JSON.stringify(heartbeat, null, 2)}\n`).toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });
    if (saved.status === 409) {
      await saved.body?.cancel();
      continue; // Re-read the current blob; never force-push or overwrite blindly.
    }
    check(saved.ok, `Cannot save schedule heartbeat: HTTP ${saved.status}`);
    const result = await saved.json();
    check(/^[a-f0-9]{40}$/.test(result.commit?.sha) && result.content?.path === HEARTBEAT_PATH, 'GitHub did not confirm the heartbeat commit');
    return { status: 'updated', checkedAt: heartbeat.checkedAt, nextDueAt: new Date(timestamp.getTime() + INTERVAL_MS).toISOString(), commit: result.commit.sha };
  }
  throw new Error('Heartbeat changed concurrently three times; a later daily run will retry');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await maintainSchedule();
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Automatic schedule maintenance\n\nStatus: **${result.status}**. Repository activity is recorded every ${INTERVAL_DAYS} days, independently of data collection.\n\nLast maintenance: ${result.checkedAt}. Next due: ${result.nextDueAt}.\n${result.commit ? `\nCommit: ${result.commit}\n` : ''}`, 'utf8');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Schedule maintenance failed';
    console.error(process.env.GITHUB_TOKEN ? message.replaceAll(process.env.GITHUB_TOKEN, '[REDACTED]') : message);
    process.exitCode = 1;
  }
}
