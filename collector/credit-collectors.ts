import type { Row, Snapshot, Source } from './types';

export type CreditCollectionResult = {
  source: string;
  status: 'success' | 'unchanged' | 'warning' | 'error' | 'needs_source';
  detail: string;
  latestDate?: string;
  url?: string;
};
export type CreditCollectorOptions = {
  fetch?: typeof fetch;
  now?: Date | string;
  /** A declared application/contact User-Agent for SEC fair access. */
  secUserAgent?: string;
};
type Disclosure = { id: string; date: string; title: string; detail: string; url: string; dateBasis: string; accession?: string; reportDate?: string };
const DAY = 86_400_000;
const SEC_URL = 'https://data.sec.gov/submissions/CIK0001769628.json';
const NEWS_URL = 'https://www.coreweave.com/newsroom';
const FINRA_TERMS = 'https://www.finra.org/finra-data/fixed-income/user-agreement';
const YIELDS = ['year3Pct', 'year5Pct', 'year7Pct', 'year10Pct'] as const;
const HEADERS = ['3 Yr', '5 Yr', '7 Yr', '10 Yr'];
const DEFAULT_AGENT = 'NeocloudResearch/1.0 (+https://pppoooppyyy.github.io/neocloud-observatory/)';

function day(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function checkedDay(value: unknown, today: string): string {
  if (!day(value) || value > today) throw new Error('来源包含无效或未来日期，保留旧记录');
  return value;
}
function decode(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (full, key: string) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? full;
    const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  });
}
function text(value: string): string {
  return decode(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function attrs(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], decode(m[2] ?? m[3])]));
}
function idHash(value: string): string {
  let n = 2166136261;
  for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619);
  return (n >>> 0).toString(16).padStart(8, '0');
}
export function treasuryUrl(year: number): string {
  return `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?field_tdr_date_value=${year}&type=daily_treasury_yield_curve`;
}

/** Read the official table by column names, including its unrelated bank-discount columns. */
export function parseTreasuryHtml(html: string, year: number, today: string): Row[] {
  const rows = new Map<string, Row>();
  let found = false;
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const headings = [...table[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => text(m[1]));
    const columns = HEADERS.map(name => headings.indexOf(name));
    const dateColumn = headings.indexOf('Date');
    if (dateColumn < 0 || columns.some(index => index < 0)) continue;
    found = true;
    for (const tr of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => text(m[1]));
      if (!cells.length) continue;
      const dateMatch = cells[dateColumn]?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!dateMatch) throw new Error('财政部表格日期格式改变，保留旧记录');
      const date = checkedDay(`${dateMatch[3]}-${dateMatch[1].padStart(2, '0')}-${dateMatch[2].padStart(2, '0')}`, today);
      if (Number(dateMatch[3]) !== year) throw new Error('财政部返回年份与请求不符');
      const values = columns.map(index => cells[index]);
      // N/A/holiday rows do not become zero, or repeat the previous business day.
      if (values.some(value => value === '' || /^(?:N\/?A|—|-)$/i.test(value ?? ''))) continue;
      if (values.some(value => !/^-?\d+(?:\.\d+)?$/.test(value ?? '') || !Number.isFinite(Number(value)))) throw new Error('财政部收益率缺失或格式改变');
      const row: Row = { date, sourceId: `us-treasury-cmt-${year}` };
      YIELDS.forEach((key, i) => { row[key] = Number(values[i]); });
      const prior = rows.get(date);
      if (prior && YIELDS.some(key => prior[key] !== row[key])) throw new Error('财政部同日数据冲突');
      rows.set(date, row);
    }
  }
  if (!found || !rows.size) throw new Error('财政部未返回有效曲线，保留旧记录');
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function accessionFromUrl(url: string): string | undefined {
  return url.match(/\/Archives\/edgar\/data\/1769628\/(\d{18})\//i)?.[1];
}

/** Only 8-K debt-creation / acceleration items; 1.01 alone is not evidence of debt. */
export function parseCoreWeaveSubmissions(value: unknown, today: string): Disclosure[] {
  const body = value as Row;
  if (!body || Number(body.cik) !== 1769628 || !/^CoreWeave\b/i.test(body.name)) throw new Error('SEC 返回公司标识不符');
  const recent = body.filings?.recent;
  const keys = ['accessionNumber', 'filingDate', 'reportDate', 'form', 'items', 'primaryDocument'];
  if (!recent || keys.some(key => !Array.isArray(recent[key])) || keys.some(key => recent[key].length !== recent.form.length)) throw new Error('SEC 申报字段或长度不一致');
  if (!recent.form.length) throw new Error('SEC 申报列表为空');
  const seen = new Set<string>();
  const output: Disclosure[] = [];
  for (let i = 0; i < recent.form.length; i++) {
    if (!['8-K', '8-K/A'].includes(recent.form[i])) continue;
    const items = String(recent.items[i]).split(/[\s,;]+/);
    const debt = items.filter(item => item === '2.03' || item === '2.04');
    if (!debt.length) continue;
    const date = checkedDay(recent.filingDate[i], today);
    const reportDate = recent.reportDate[i] ? checkedDay(recent.reportDate[i], date) : undefined;
    const accession = recent.accessionNumber[i];
    const document = recent.primaryDocument[i];
    if (typeof accession !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || typeof document !== 'string' || !/^[\w.-]+\.(?:htm|html|txt)$/i.test(document)) throw new Error('SEC 文件标识格式改变');
    if (seen.has(accession)) throw new Error('SEC 申报编号重复');
    seen.add(accession);
    const compact = accession.replaceAll('-', '');
    const labels = debt.map(item => item === '2.03' ? '直接财务义务或表外义务披露' : '债务加速到期等触发事项披露');
    output.push({
      id: `crwv-sec-debt-${compact}`, date, reportDate, accession: compact,
      title: `CoreWeave ${recent.form[i]}：${labels.join('；')}`,
      detail: `SEC Item ${debt.join(' / ')}；日期为申报日，具体金额、条款和事项日期见原文件。`,
      url: `https://www.sec.gov/Archives/edgar/data/1769628/${compact}/${document}`, dateBasis: 'filing',
    });
  }
  return output.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseCoreWeaveNewsroom(html: string, today: string): { disclosures: Disclosure[]; latestDate: string; count: number } {
  const tags = [...html.matchAll(/<[^>]+\bdata-date-start\s*=\s*["'][^>]*>/gi)];
  if (!tags.length) throw new Error('CoreWeave 官网新闻列表格式改变或返回访问验证页');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const disclosures: Disclosure[] = [];
  let latestDate = '';
  for (let i = 0; i < tags.length; i++) {
    const a = attrs(tags[i][0]);
    const match = a['data-date-start']?.match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
    const month = match ? monthNames.indexOf(match[1]) + 1 : 0;
    if (!match || month === 0) throw new Error('CoreWeave 新闻日期格式改变');
    const date = checkedDay(`${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`, today);
    latestDate = date > latestDate ? date : latestDate;
    const title = text(a['data-title'] || '');
    if (!title) throw new Error('CoreWeave 新闻标题为空');
    if (!/\b(?:senior notes?|convertible notes?|debt financ(?:ing|e)|loan facilit(?:y|ies)|credit facilit(?:y|ies)|refinanc(?:ing|e)|debt redemption)\b/i.test(title)) continue;
    const segment = html.slice(tags[i].index! + tags[i][0].length, tags[i + 1]?.index ?? html.length);
    const linkTag = [...segment.matchAll(/<a\b[^>]*>/gi)].find(m => /\bresource__data-link\b/.test(attrs(m[0]).class || ''));
    const href = a['data-external-url'] || (linkTag ? attrs(linkTag[0]).href : '');
    const url = new URL(href, NEWS_URL);
    if (!href || url.protocol !== 'https:' || !['www.coreweave.com', 'investors.coreweave.com'].includes(url.hostname) || url.username || url.password) throw new Error('CoreWeave 债务新闻链接不是官方 HTTPS 来源');
    url.hash = '';
    disclosures.push({ id: `crwv-news-${idHash(url.href)}`, date, title, url: url.href, dateBasis: 'source_listed_date', detail: 'CoreWeave 官网新闻列表披露；日期按官网列表，债务金额和条款见原文。' });
  }
  return { disclosures, latestDate, count: tags.length };
}

async function request(url: string, fetcher: typeof fetch, accept: string, userAgent?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
  try {
    const response = await fetcher(url, { cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: accept, ...(userAgent ? { 'User-Agent': userAgent } : {}) } });
    if (!response.ok) throw new Error(`来源 HTTP ${response.status}，保留旧记录`);
    const body = await response.text();
    if (!body || body.length > 3_000_000) throw new Error('来源内容为空或超过大小限制');
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('来源超过18秒未完成，保留旧记录');
    throw error;
  } finally { clearTimeout(timer); }
}

/**
 * 3 public requests normally; 4 in January to retain the last prior-year curve.
 * No FINRA requests, no bond quote mutation, no synthetic G-spread or CDS points.
 * A market quote needs a licensed source with explicit YTM and same-day Treasury
 * before it can be used; FINRA's lastSaleYield is YTW, not automatically YTM.
 */
export async function collectCredit(old: Snapshot, options: CreditCollectorOptions = {}): Promise<{ patch: Partial<Snapshot>; results: CreditCollectionResult[] }> {
  const now = new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error('采集时间无效');
  const observedAt = now.toISOString();
  const today = observedAt.slice(0, 10);
  const cutoff = new Date(now.getTime() - 370 * DAY).toISOString().slice(0, 10);
  const fetcher = options.fetch ?? fetch;
  const patch: Partial<Snapshot> = {};
  const results: CreditCollectionResult[] = [];
  const sources = new Map(old.sources.map(source => [source.id, source]));
  const addedSources = new Map<string, Source>();
  const events: Row[] = [];
  function sourceFor(url: string, id: string, name: string, description: string): string {
    const existing = [...sources.values()].find(source => source.url === url);
    if (existing) return existing.id;
    if (sources.has(id) && sources.get(id)!.url !== url) throw new Error('来源标识与既有链接冲突');
    const source = { id, name, url, kind: 'official', description };
    sources.set(id, source); addedSources.set(id, source);
    return id;
  }
  function appendDisclosures(rows: Disclosure[]): number {
    // Validate the whole source batch before staging any event/source changes.
    const pending: Disclosure[] = [];
    const plannedSourceIds = new Map<string, string>();
    for (const row of rows.filter(item => item.date >= cutoff)) {
      const prior = [...old.events, ...events].some(event => {
        const url = sources.get(event.sourceId)?.url;
        return event.id === row.id || url === row.url || (row.accession && (event.accession === row.accession || (url && accessionFromUrl(url) === row.accession)));
      });
      if (prior || pending.some(item => item.id === row.id || item.url === row.url)) continue;
      const sourceId = `${row.id}-source`;
      if (![...sources.values()].some(source => source.url === row.url)) {
        const existingUrl = sources.get(sourceId)?.url ?? plannedSourceIds.get(sourceId);
        if (existingUrl && existingUrl !== row.url) throw new Error('来源标识与既有链接冲突');
        plannedSourceIds.set(sourceId, row.url);
      }
      pending.push(row);
    }
    let count = 0;
    for (const row of pending) {
      const sourceId = sourceFor(row.url, `${row.id}-source`, row.title, row.dateBasis === 'filing' ? 'SEC 官方 CoreWeave 债务相关 8-K 申报。' : 'CoreWeave 官方新闻；仅跟踪公开债务公告，不替代二级市场行情。');
      const { url: _url, ...fields } = row;
      events.push({ ...fields, sourceId, observedAt, category: 'credit_disclosure' });
      count++;
    }
    return count;
  }
  function failure(source: string, url: string, error: unknown) {
    results.push({ source, url, status: 'error', detail: error instanceof Error ? error.message : '来源读取失败，保留旧记录' });
  }
  const years = [now.getUTCFullYear(), ...(now.getUTCMonth() === 0 ? [now.getUTCFullYear() - 1] : [])];
  await Promise.all([
    ...years.map(async year => {
      const url = treasuryUrl(year);
      try {
        const rows = parseTreasuryHtml(await request(url, fetcher, 'text/html'), year, today);
        const sourceId = sourceFor(url, `us-treasury-cmt-${year}`, `U.S. Treasury ${year} Daily Treasury Par Yield Curve Rates`, '美国财政部官方每日平价收益率曲线；3/5/7/10年，单位为百分比。保留实际公布日期，不填周末或节假日。');
        const prior = new Map((old.treasury || []).map(row => [row.date, row]));
        const changed = rows.filter(row => !prior.has(row.date) || YIELDS.some(key => prior.get(row.date)![key] !== row[key])).map(row => ({ ...row, sourceId, observedAt }));
        if (changed.length) patch.treasury = [...(patch.treasury || []), ...changed];
        const latestDate = rows.at(-1)!.date;
        const oldLatest = (old.treasury || []).filter(row => row.date?.startsWith(`${year}-`)).reduce((last, row) => row.date > last ? row.date : last, '');
        results.push({ source: `美国财政部 ${year} 曲线`, url, status: latestDate < oldLatest ? 'warning' : changed.length ? 'success' : 'unchanged', latestDate, detail: `读取${rows.length}个公布日，新增或修订${changed.length}日；最新公布日期${latestDate}${latestDate < oldLatest ? '，来源日期回退，已有历史保留' : ''}` });
      } catch (error) { failure(`美国财政部 ${year} 曲线`, url, error); }
    }),
    (async () => {
      try {
        const data = parseCoreWeaveNewsroom(await request(NEWS_URL, fetcher, 'text/html'), today);
        const count = appendDisclosures(data.disclosures);
        results.push({ source: 'CoreWeave 官网债务新闻', url: NEWS_URL, status: count ? 'success' : 'unchanged', latestDate: data.latestDate, detail: `读取官网${data.count}条新闻，新增${count}条债务公告；官网列表不覆盖全部 IR 债券公告，另查 SEC 债务申报` });
      } catch (error) { failure('CoreWeave 官网债务新闻', NEWS_URL, error); }
    })(),
    (async () => {
      try {
        const agent = options.secUserAgent?.trim() || DEFAULT_AGENT;
        if (/[\r\n]/.test(agent)) throw new Error('SEC User-Agent 格式无效');
        const rows = parseCoreWeaveSubmissions(JSON.parse(await request(SEC_URL, fetcher, 'application/json', agent)), today);
        const count = appendDisclosures(rows);
        results.push({ source: 'CoreWeave SEC 债务申报', url: SEC_URL, status: count ? 'success' : 'unchanged', ...(rows.length ? { latestDate: rows.at(-1)!.date } : {}), detail: `新增${count}条债务相关 8-K；仅使用 Item 2.03/2.04，日期为申报日，不自动改债券本金或行情` });
      } catch (error) { failure('CoreWeave SEC 债务申报', SEC_URL, error); }
    })(),
  ]);
  if (addedSources.size) patch.sources = [...addedSources.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (events.length) patch.events = events.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  if (patch.treasury) patch.treasury.sort((a, b) => a.date.localeCompare(b.date));
  results.push({ source: 'CoreWeave 逐券行情', status: 'needs_source', url: FINRA_TERMS, detail: '暂无允许自动采集并在本站分发的逐券行情来源；保留原行情。FINRA 公开网页有使用限制且 lastSaleYield 为 YTW，未写入 YTM、G-spread 或 CDS。' });
  return { patch, results: results.sort((a, b) => a.source.localeCompare(b.source)) };
}
