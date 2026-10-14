import type { Row, Snapshot, Source } from './types';

// Public, bounded discovery. No credentials, Node APIs, scraped search engines,
// inferred exchange rates, or arbitrary URLs supplied by a stored snapshot.
export const FUNDING_FEEDS = {
  crunchbase: 'https://news.crunchbase.com/feed/',
  venture: 'https://www.prnewswire.com/rss/financial-services-latest-news/venture-capital-list.rss',
  financing: 'https://www.prnewswire.com/rss/financial-services-latest-news/financing-agreements-list.rss',
};
const MAX_BYTES = 2_000_000, TIMEOUT_MS = 12_000;
const HOSTS = new Set(['news.crunchbase.com', 'www.prnewswire.com']);
type Article = { title: string; url: string; publishedAt: string; html: string; issuer?: string; kind: 'crunchbase' | 'release'; fullText?: boolean };
type Result = { source: string; status: string; detail: string; sourceUrl?: string; latestDate?: string; observedAt: string };
type Options = { fetch?: typeof fetch; now?: string; lookbackDays?: number };
type Window = { start: string; end: string };

function entities(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? all;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}
function plain(html: string): string {
  return entities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function canonical(url: string): string {
  try { const u = new URL(entities(url)); u.hash = ''; u.search = ''; return u.href.replace(/\/$/, ''); } catch { return ''; }
}
function safeUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && HOSTS.has(u.hostname) && !u.username && !u.password && !u.port; } catch { return false; }
}
function identity(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/\b(?:incorporated|inc|ltd|llc|corp|corporation)\b/g, '').replace(/[^a-z0-9]/g, ''); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80); }
function hash(value: string): string { let h = 2166136261; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(16); }
function day(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const n = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value ? value : null;
}
function stamp(value: string): string | null { const n = Date.parse(value); return Number.isFinite(n) ? new Date(n).toISOString() : null; }
function week(end: string): string {
  const d = new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((+d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
function friday(date: string): string { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (5 - d.getUTCDay() + 7) % 7); return d.toISOString().slice(0, 10); }
function xmlTag(xml: string, name: string): string { return entities(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || ''); }

export function parseFundingRss(xml: string, kind: Article['kind']): Article[] {
  if (!/<rss\b/i.test(xml)) throw new Error('RSS 格式改变');
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, 60).flatMap(match => {
    const item = match[1], url = xmlTag(item, 'link').trim(), publishedAt = stamp(xmlTag(item, 'pubDate'));
    if (!safeUrl(url) || !publishedAt) return [];
    return [{ url, publishedAt, title: plain(xmlTag(item, 'title')), html: xmlTag(item, 'content:encoded') || xmlTag(item, 'description'), issuer: plain(xmlTag(item, 'dc:contributor')), kind, fullText: kind === 'crunchbase' && !!xmlTag(item, 'content:encoded') }];
  });
}

function wpArticles(value: unknown): Article[] {
  if (!Array.isArray(value)) throw new Error('公开新闻接口格式改变');
  return value.slice(0, 30).flatMap(post => {
    const publishedAt = typeof post?.date_gmt === 'string' ? stamp(post.date_gmt + 'Z') : null;
    if (!publishedAt || typeof post?.title?.rendered !== 'string' || typeof post?.content?.rendered !== 'string' || !safeUrl(post.link) || new URL(post.link).hostname !== 'news.crunchbase.com') return [];
    return [{ title: plain(post.title.rendered), html: post.content.rendered, url: post.link, publishedAt, kind: 'crunchbase' as const, fullText: true }];
  });
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function sampleWindow(html: string): Window | null {
  const text = plain(html);
  if (!/U\.S\.-based companies/i.test(text)) return null;
  const m = text.match(/period (?:of|from)\s+([A-Za-z]+)\.?\s+(\d{1,2})(?:,?\s+(20\d{2}))?\s*[-–—]\s*(?:([A-Za-z]+)\.?\s+)?(\d{1,2}),?\s+(20\d{2})/i);
  if (!m) return null;
  const endYear = Number(m[6]), startMonth = MONTHS[m[1].slice(0, 3).toLowerCase()], endMonth = m[4] ? MONTHS[m[4].slice(0, 3).toLowerCase()] : startMonth;
  const startYear = Number(m[3] || (startMonth > endMonth ? endYear - 1 : endYear));
  const start = day(`${startYear}-${String(startMonth).padStart(2, '0')}-${m[2].padStart(2, '0')}`), end = day(`${endYear}-${String(endMonth).padStart(2, '0')}-${m[5].padStart(2, '0')}`);
  if (!start || !end || Date.parse(end) - Date.parse(start) !== 6 * 86400000 || new Date(end).getUTCDay() !== 5) return null;
  return { start, end };
}

function money(value: string): { value: number; token: string; qualifier: string } | null {
  const m = value.match(/((?:US\s*)?\$|USD\s*)\s*([\d,]+(?:\.\d+)?)\s*(billion|million|bn|mm|[bm])\b/i);
  if (!m) return null;
  const n = Number(m[2].replaceAll(',', '')) * (/^(billion|bn|b)$/i.test(m[3]) ? 1000 : 1);
  if (!(n > 0) || !Number.isFinite(n)) return null;
  const lead = value.slice(Math.max(0, (m.index || 0) - 35), m.index);
  const qualifier = /\bup to\b/i.test(lead) ? 'up_to' : /\b(?:more than|over|at least)\b/i.test(lead) ? 'greater_than' : /\b(?:about|around|approximately|nearly)\b/i.test(lead) ? 'approximate' : 'exact_as_reported';
  return { value: n, token: m[0], qualifier };
}

function classify(title: string, text: string, sector: string): Row {
  const evidence = text.slice(0, 750), sentences = evidence.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const lead = sentences.find(sentence => money(sentence)) || sentences.slice(0, 2).join(' ');
  const roundEvidence = title + ' ' + lead;
  const roundMatch = roundEvidence.match(/\bSeries\s+([A-H])(?:[ -](\d+))?(?:\s+(extension))?\b/i);
  const round = roundMatch ? `Series ${roundMatch[1].toUpperCase()}${roundMatch[2] || ''}${roundMatch[3] ? ' extension' : ''}` : /pre[- ]seed/i.test(roundEvidence) ? 'Pre-seed' : /\bseed (?:round|funding|financing)/i.test(roundEvidence) ? 'Seed' : 'Undisclosed';
  const stage = /seed/i.test(round) ? 'seed' : /^Series [AB](?:\d)?(?: |$)/.test(round) ? 'early' : /^Series [C-H]/.test(round) ? 'growth' : 'unknown';
  const equity = /\bequity (?:funding|financing|investment|round)|\b(?:newly issued|new) (?:preferred )?shares\b/i.test(lead) || !!roundMatch || /\bseed (?:funding|round|financing)\b/i.test(lead);
  const debt = /\bdebt\b|credit facilit|\bloan\b|convertible notes?|senior notes?/i.test(lead);
  const secondary = /secondary (?:sale|transaction|shares)|purchas(?:e|ing|ed) (?:existing )?shares .{0,60}\bfrom\b|employee liquidity|tender offer/i.test(lead);
  const cumulative = /(?:raised|funding|financing).{0,40}\bto date\b|\bcumulative\b|\btotal (?:funding|financing)\b/i.test(lead) && !/\b(?:new|fresh)\b|\b(?:Series [A-H]|seed)\b/i.test(lead);
  const tranche = /\btranche\b|previously announced|final (?:instalment|installment|payment)/i.test(lead);
  const resources = /(?:cash|equity).{0,70}(?:resources|in.kind)|strategic (?:seed )?commitment/i.test(lead);
  const commitment = /\bup to\b|\bcommitment\b/i.test(title + ' ' + lead);
  const amount = money(title), bodyAmount = money(lead);
  const amountConflict = !!amount && !!bodyAmount && amount.value !== bodyAmount.value;
  const qualifier = amount?.qualifier !== 'exact_as_reported' ? amount?.qualifier : bodyAmount?.qualifier || 'exact_as_reported';
  const transactionType = tranche ? 'tranche_payment' : resources || (debt && equity) || (secondary && equity) ? 'mixed' : secondary ? 'secondary' : debt ? 'debt' : equity ? 'primary_equity' : 'unknown';
  const amountBasis = tranche ? 'tranche' : cumulative ? 'cumulative_to_date' : commitment ? 'commitment' : 'single_round';
  const basis = (sector + ' ' + lead).toLowerCase();
  let category = 'unknown', neocloudScope = 'outside';
  if (/ai infrastructure|cloud and power infrastructure|gpu cloud|gpu (?:cloud|cluster|infrastructure)|data cent(?:er|re)|compute infrastructure/.test(basis)) { category = 'ai_infra'; neocloudScope = 'core'; }
  else if (/ai (?:evaluation|chips|semiconductors)|training data|data label|model (?:evaluation|infrastructure)/.test(basis)) { category = 'ai_infra'; neocloudScope = 'adjacent'; }
  else if (/foundational ai|foundation(?:al)? models?|large language model|\bai model\b/.test(basis)) category = 'ai_model';
  else if (/\bai\b|artificial intelligence/.test(basis)) category = 'ai_app';
  else if (sector && /biotech|insurance|fintech|health|energy|fusion|manufacturing|space|security|real estate|robotics|software|banking|pharma|transport|communications/.test(sector.toLowerCase())) category = 'other';
  const resolved = transactionType !== 'unknown' && !amountConflict && category !== 'unknown';
  return { round, stage, category, subsector: sector || 'not_classified', neocloudScope, transactionType, amountBasis,
    amountQualifier: qualifier || 'exact_as_reported', classificationResolved: resolved,
    reportedSingleRoundEquity: transactionType === 'primary_equity' && amountBasis === 'single_round' && qualifier === 'exact_as_reported' && !amountConflict,
    note: amountConflict ? '标题与正文融资金额不一致，待核。' : !resolved ? '公开文本尚不足以确认全部分类，不进入周度合计。' : '',
    classificationBasis: 'deterministic_explicit_text', transactionEvidence: 'reported_funding_round_not_legal_instrument_verified' };
}

export function parseFundingWeekly(article: Article): { window: Window | null; complete: boolean; rows: Row[]; issue?: string } {
  const window = sampleWindow(article.html), rows: Row[] = [];
  if (!/10 Biggest Funding Rounds/i.test(article.title) || !window) return { window, complete: false, rows, issue: '无法确认明确的美国周榜和周六至周五窗口' };
  const blocks = [...article.html.matchAll(/<(p|h[2-4])\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  for (let i = 0; i < blocks.length; i++) {
    const text = plain(blocks[i][2]);
    const m = text.match(/^(\d{1,2})\.\s*(?:\(tied\)\s*)?(.+?),\s*((?:US\s*)?\$[\d,.]+\s*(?:billion|million|bn|[bm]))\s*,\s*([^:]+):\s*(.*)$/i);
    if (!m) continue;
    const rank = Number(m[1]); if (rank < 1 || rank > 10) continue;
    let body = m[5];
    if (!body && blocks[i + 1] && !/^\d{1,2}\./.test(plain(blocks[i + 1][2]))) body = plain(blocks[i + 1][2]);
    const amount = money(m[3]); if (!amount || !body || /(?:C\$|A\$|HK\$|S\$|€|£|Canadian dollars|Australian dollars)/i.test(text)) continue;
    rows.push({ company: m[2].trim(), amountUsdM: amount.value, reportedHeadlineAmountUsdM: amount.value, currency: 'USD',
      sampleRank: rank, ...classify(m[3], body, m[4].trim()), disclosureExcerpt: body.slice(0, 180) });
  }
  const unique = new Set(rows.map(row => identity(row.company)));
  const complete = rows.length >= 10 && rows.length <= 20 && unique.size === rows.length && rows[0]?.sampleRank === 1 && rows.every((row, i) => i === 0 || row.sampleRank === rows[i - 1].sampleRank || row.sampleRank === i + 1);
  return { window, rows, complete, ...(!complete ? { issue: '排名未完整解析，保留周度缺口' } : {}) };
}

function releaseBody(html: string): string {
  const section = html.match(/<section\b[^>]*class=["'][^"']*release-body[^"']*["'][^>]*>([\s\S]*?)<\/section>/i)?.[1];
  if (section) return plain(section);
  return plain(html);
}
function dailyCandidate(article: Article): boolean {
  return /\$|\bUSD\b/.test(article.title) && /rais(?:e[sd]?|ing)|land[sd]?|secur(?:e[sd]?|ing)|clos(?:e[sd]?|ing)|complet(?:e[sd]?|ing)|launch(?:es|ed)?|announc(?:e[sd]?|ing)/i.test(article.title)
    && !/\bfund\s+(?:[IVX]+|\d+)\b|\b(?:venture|investment|private equity) fund\b|\bARR\b|\brevenue\b|\bassets under management\b/i.test(article.title);
}
function dailyRow(article: Article): Row | null {
  const title = article.title.replace(/^Exclusive:\s*/i, '');
  const prefix = title.match(/^(.{2,100}?)\s+(?:Raises?|Raised|Lands?|Secures?|Closes?|Completes?|Announces?|Launches?)\b/i)?.[1]?.trim();
  // Editorial prefixes ("Can You Trust...? Company Raises...") are not names.
  // Prefer a named Crunchbase organization anchored in the article itself.
  const named = [...article.html.matchAll(/<a\b[^>]*href=["']https:\/\/(?:www\.)?crunchbase\.com\/organization\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => plain(match[1])).filter(name => name.length >= 3 && prefix && identity(prefix).endsWith(identity(name))).sort((a, b) => b.length - a.length);
  const cleanPrefix = prefix && prefix.split(/\s+/).length <= 7 && !/[?:,!]/.test(prefix) && !/^(?:from|how|why|can|who|what|the founder|a startup)\b/i.test(prefix);
  const company = named[0] || (cleanPrefix ? prefix : undefined);
  const amount = money(title); if (!company || !amount) return null;
  // A headline containing multiple financing amounts needs component review.
  if ([...title.matchAll(/(?:\$|USD\s*)\s*[\d,.]+\s*(?:[bm]\b|billion|million)/gi)].length !== 1) return null;
  const text = releaseBody(article.html), combined = title + ' ' + text;
  const explicitUsd = /US\s*\$|\bUSD\b|U\.S\. dollars/i.test(combined);
  const usDateline = /(?:NEW YORK|SAN FRANCISCO|PALO ALTO|AUSTIN|BOSTON|SAN JOSE|LOS ANGELES|DALLAS|CHICAGO|SAN DIEGO|SEATTLE|WASHINGTON|MIAMI|DENVER|ATLANTA)\s*(?:,\s*[A-Za-z.]+\s*)?,\s+[A-Z][a-z]+\.?\s+\d{1,2},?\s+20\d{2}\s+\/PRNewswire\//.test(text);
  const foreign = /(?:C\$|A\$|HK\$|S\$|€|£|Canadian dollars|Australian dollars|Hong Kong dollars|Singapore dollars)/i.test(combined);
  if (foreign || !(article.kind === 'crunchbase' || explicitUsd || usDateline)) return null;
  const c = classify(title, text, '');
  if (article.kind === 'release' && !article.fullText) Object.assign(c, { transactionType: 'unknown', classificationResolved: false, reportedSingleRoundEquity: false, note: '仅取得公司 RSS 披露摘要；融资条款尚未完整核实。' });
  const issuerVerified = article.kind === 'release' && !!article.issuer && identity(article.issuer) === identity(company);
  const localPublished = article.html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})T/i)?.[1];
  const announcementDate = localPublished && day(localPublished) && Math.abs(Date.parse(localPublished) - Date.parse(article.publishedAt.slice(0, 10))) <= 86400000 ? localPublished : article.publishedAt.slice(0, 10);
  return { company, amountUsdM: amount.value, reportedHeadlineAmountUsdM: amount.value, currency: 'USD',
    currencyBasis: explicitUsd ? 'explicit_USD' : article.kind === 'crunchbase' ? 'Crunchbase_USD_reporting' : 'US_press_release_dateline',
    ...c, issuerVerified, announcementDate: issuerVerified ? announcementDate : null,
    geography: /\bU\.S\.-based|\bUS-based|\bUnited States-based/i.test(text) ? 'US' : 'unknown',
    disclosureExcerpt: text.slice(0, 180) };
}

function resolvePrior(deal: Row, window: Window, sourceUrl: string, old: Row[], sources: Source[]): Row | undefined {
  const byId = new Map(sources.map(source => [source.id, canonical(source.url)]));
  const companyRows = old.filter(row => identity(row.company || '') === identity(deal.company));
  const ranked = companyRows.filter(row => deal.sampleRank != null && row.sampleRank === deal.sampleRank && row.sourceWindowStart === window.start && row.sourceWindowEnd === window.end);
  if (ranked.length === 1) return ranked[0];
  const matches = companyRows.filter(row => (
    (row.disclosureUrls || []).includes(canonical(sourceUrl)) || byId.get(row.sourceId) === canonical(sourceUrl) || byId.get(row.primarySourceId) === canonical(sourceUrl) ||
    (((row.announcementDate || row.reportDate) >= window.start && (row.announcementDate || row.reportDate) <= window.end || row.sourceWindowStart >= window.start && row.sourceWindowEnd <= window.end) &&
      (row.reportedHeadlineAmountUsdM ?? row.amountUsdM) === deal.amountUsdM)
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function collectFunding(snapshot: Snapshot, options: Options = {}): Promise<{ patch: Partial<Snapshot>; results: Result[] }> {
  const now = options.now || new Date().toISOString(), nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('Invalid collection timestamp');
  const lookback = Math.max(7, Math.min(90, options.lookbackDays ?? 28));
  const after = new Date(nowMs - lookback * 86400000).toISOString().slice(0, 19);
  const fetcher = options.fetch || fetch, results: Result[] = [], sources: Source[] = [], deals: Row[] = [], events: Row[] = [];
  const history = new Map((snapshot.history || []).map(series => [series.id, { ...series, points: [] as Row[] }]));
  const allDeals = [...snapshot.deals]; let requests = 0;
  const result = (source: string, status: string, detail: string, sourceUrl?: string, latestDate?: string) => results.push({ source, status, detail, sourceUrl, latestDate, observedAt: now });
  async function read(url: string): Promise<string> {
    if (!safeUrl(url) || ++requests > 8) throw new Error('公开来源请求预算已达上限');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetcher(url, { headers: { Accept: 'application/json, application/rss+xml, text/html' }, signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error(`公开来源 HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('来源正文超出大小限制');
      const reader = response.body?.getReader(); if (!reader) throw new Error('来源无正文');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new Error('来源正文超出大小限制'); } chunks.push(value); } }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally { clearTimeout(timeout); }
  }
  function source(article: Article, official = false): Source {
    const known = [...snapshot.sources, ...sources].find(row => canonical(row.url) === canonical(article.url));
    if (known) return known;
    const row = { id: 'funding-source-' + hash(canonical(article.url)), name: `${official ? '公司公告' : article.kind === 'release' ? 'PR Newswire 披露' : 'Crunchbase News'} · ${article.title}`,
      url: article.url, kind: official ? 'official' : 'secondary', description: `公开披露 ${article.publishedAt.slice(0, 10)}；实际采集 ${now}。${article.kind === 'crunchbase' ? '公开报道样本，非全市场全集。' : '新闻稿；金额、币种和分类须保留各条证据。'}` };
    sources.push(row); return row;
  }
  const fields = 'id,link,date_gmt,title,content';
  const urls = [
    `https://news.crunchbase.com/wp-json/wp/v2/posts?per_page=30&after=${after}&orderby=date&order=desc&_fields=${fields}`,
    `https://news.crunchbase.com/wp-json/wp/v2/posts?per_page=15&search=biggest%20funding%20rounds&after=${after}&orderby=date&order=desc&_fields=${fields}`,
    FUNDING_FEEDS.venture, FUNDING_FEEDS.financing,
  ];
  const fetched = await Promise.allSettled(urls.map(read));
  const articles: Article[] = []; let wpFailed = false;
  fetched.forEach((response, index) => {
    const label = index < 2 ? 'Crunchbase 公开融资新闻' : 'PR Newswire 融资公告';
    try {
      if (response.status === 'rejected') throw response.reason;
      const rows = index < 2 ? wpArticles(JSON.parse(response.value)) : parseFundingRss(response.value, 'release');
      articles.push(...rows);
      result(label, rows.length ? 'success' : 'warning', `读取 ${rows.length} 篇公开披露；仅解析明确字段。`, urls[index], rows[0]?.publishedAt.slice(0, 10));
    } catch (error) {
      if (index < 2) wpFailed = true;
      result(label, 'error', `${error instanceof Error ? error.message : '读取失败'}；保留原融资历史。`, urls[index]);
    }
  });
  if (wpFailed) {
    try { const rows = parseFundingRss(await read(FUNDING_FEEDS.crunchbase), 'crunchbase'); articles.push(...rows); result('Crunchbase RSS 回退', 'success', `读取 ${rows.length} 篇；RSS 范围有限，未覆盖周不补值。`, FUNDING_FEEDS.crunchbase); }
    catch { result('Crunchbase RSS 回退', 'error', '公开新闻回退失败；保留原历史。', FUNDING_FEEDS.crunchbase); }
  }
  const unique = [...new Map(articles.filter(a => Date.parse(a.publishedAt) <= nowMs && Date.parse(a.publishedAt) >= nowMs - lookback * 86400000).map(a => [canonical(a.url), a])).values()];
  const releases = unique.filter(a => a.kind === 'release' && dailyCandidate(a)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 3);
  await Promise.all(releases.map(async article => {
    try { article.html = await read(article.url); article.fullText = true; }
    catch { result('公司融资公告', 'warning', '正文无法读取，仅保留 RSS 披露，未核清字段不进入合计。', article.url); }
  }));
  // Process complete ranked samples first so daily cross-posts cannot duplicate them.
  const ordered = unique.filter(a => a.kind === 'crunchbase' || dailyCandidate(a)).sort((a, b) => Number(/10 Biggest Funding Rounds/i.test(b.title)) - Number(/10 Biggest Funding Rounds/i.test(a.title)) || a.publishedAt.localeCompare(b.publishedAt));
  for (const article of ordered) {
    if (/10 Biggest Funding Rounds/i.test(article.title)) {
      const parsed = parseFundingWeekly(article);
      if (!parsed.window || parsed.window.end > now.slice(0, 10) || parsed.window.end > article.publishedAt.slice(0, 10)) {
        result('美国十大融资周榜', 'warning', parsed.issue || '周窗口与发布日期不符；未追加历史。', article.url); continue;
      }
      const sourceRow = source(article), ranked: Row[] = [];
      for (const row of parsed.rows) {
        const prior = resolvePrior(row, parsed.window, article.url, allDeals, [...snapshot.sources, ...sources]);
        const sameAmount = !prior || (prior.reportedHeadlineAmountUsdM ?? prior.amountUsdM) === row.amountUsdM;
        if (prior && !sameAmount) { result('融资披露冲突', 'warning', `${row.company} 周榜金额与已有记录不同，保留人工记录，等待核对。`, article.url); parsed.complete = false; ranked.push(prior); continue; }
        const human = prior && prior.collector !== 'public_funding_v1';
        const merged = human ? prior : { ...row, ...(prior || {}), id: prior?.id || `auto-cb-${parsed.window.end}-${slug(row.company)}`,
          company: row.company, cashDate: null, announcementDate: prior?.announcementDate || null, reportDate: article.publishedAt.slice(0, 10),
          geography: 'US', sampleWeek: week(parsed.window.end), sampleKind: 'crunchbase_top10', sampleRank: row.sampleRank,
          sourceWindowStart: parsed.window.start, sourceWindowEnd: parsed.window.end, dateBasis: prior?.announcementDate ? 'announcement' : 'source_window',
          sourceId: prior?.sourceId || sourceRow.id, rankedSourceId: sourceRow.id, primarySourceId: prior?.primarySourceId || null,
          primaryAmountVerified: prior?.primaryAmountVerified || false, status: prior?.status || 'reported', collector: 'public_funding_v1',
          includeInNewEquity: !!(prior?.reportedSingleRoundEquity ?? row.reportedSingleRoundEquity),
          disclosureUrls: [...new Set([...(prior?.disclosureUrls || []), canonical(article.url)])] };
        ranked.push(merged);
        if (!human && JSON.stringify(prior) !== JSON.stringify(merged)) { deals.push(merged); const index = allDeals.findIndex(d => d.id === merged.id); if (index >= 0) allDeals[index] = merged; else allDeals.push(merged); }
      }
      const classified = ranked.every(row => row.collector !== 'public_funding_v1' || row.classificationResolved);
      const existingHistory = (snapshot.history || []).some(s => ['us_funding', 'ai_infra_funding', 'ai_early_count'].includes(s.id) && s.points.some(p => p.date === parsed.window!.end));
      if (parsed.complete && classified && !existingHistory) {
        const eligible = ranked.filter(d => d.includeInNewEquity === true && d.transactionType === 'primary_equity' && d.amountBasis === 'single_round');
        const sums: Record<string, number> = { us_funding: eligible.reduce((n, d) => n + d.amountUsdM, 0) / 100,
          ai_infra_funding: eligible.filter(d => d.category === 'ai_infra').reduce((n, d) => n + d.amountUsdM, 0) / 100,
          ai_early_count: eligible.filter(d => ['ai_infra', 'ai_model', 'ai_app'].includes(d.category) && ['seed', 'early'].includes(d.stage)).length };
        for (const [id, value] of Object.entries(sums)) {
          const series = history.get(id); if (!series) continue;
          series.points.push({ date: parsed.window.end, value, periodStart: parsed.window.start, periodEnd: parsed.window.end,
            sourceId: sourceRow.id, windowBasis: 'explicit_article_methodology', observedRankedEvents: ranked.length,
            eligiblePrimaryEquityEvents: eligible.length, dealIds: ranked.map(d => d.id), excludedDealIds: ranked.filter(d => !eligible.includes(d)).map(d => d.id) });
        }
      }
      result('美国十大融资周榜', parsed.complete && classified ? 'success' : 'warning', `${parsed.window.start}—${parsed.window.end}：解析 ${ranked.length} 条。${existingHistory ? '保留既有核实历史。' : parsed.complete && classified ? '完整同口径样本已追加。' : '排名或交易分类未完整确认，周度曲线保持缺口。'}`, article.url, parsed.window.end);
      continue;
    }
    if (!dailyCandidate(article)) continue;
    const row = dailyRow(article), sourceRow = source(article, !!row?.issuerVerified), date = article.publishedAt.slice(0, 10);
    if (!row) {
      const eventId = 'funding-review-' + hash(canonical(article.url));
      if (!snapshot.events.some(event => event.id === eventId)) events.push({ id: eventId, date, title: article.title, detail: '新融资披露：公司、币种或融资金额尚未确定，仅保存来源，不进入融资金额或笔数合计。', sourceId: sourceRow.id, kind: 'funding_disclosure_review' });
      result('每日融资披露', 'warning', '发现披露，但公司/金额/币种无法确定；保存待核来源。', article.url, date); continue;
    }
    const end = friday(date), start = new Date(Date.parse(end) - 6 * 86400000).toISOString().slice(0, 10);
    const prior = resolvePrior(row, { start, end }, article.url, allDeals, [...snapshot.sources, ...sources]);
    if (prior) { result('每日融资披露', 'unchanged', `${row.company} 已有记录，稳定 id ${prior.id}；保留已有分类及金额。`, article.url, date); continue; }
    const newDeal = { ...row, id: `auto-funding-${slug(row.company)}-${hash(canonical(article.url))}`, collector: 'public_funding_v1', cashDate: null,
      sourceId: sourceRow.id, primarySourceId: row.issuerVerified ? sourceRow.id : null, primaryAmountVerified: row.issuerVerified && row.reportedSingleRoundEquity,
      sampleRank: null, sampleWeek: week(end), sampleKind: 'daily_disclosure', sourceWindowStart: date, sourceWindowEnd: date,
      dateBasis: row.announcementDate ? 'announcement' : 'source_window', reportDate: date, status: row.issuerVerified ? 'announced' : 'reported',
      includeInNewEquity: false, disclosureUrls: [canonical(article.url)],
      note: [row.note, '每日公开披露，独立于固定美国十大周榜；未加入该周榜前不进入历史样本合计。'].filter(Boolean).join(' ') };
    deals.push(newDeal); allDeals.push(newDeal);
    result('每日融资披露', row.classificationResolved ? 'success' : 'warning', `${row.company}：${row.amountUsdM} 百万美元；${row.transactionType}。保留独立日披露，未混入周榜。`, article.url, date);
  }
  const patch: Partial<Snapshot> = {};
  if (sources.length) patch.sources = sources;
  if (deals.length) patch.deals = [...new Map(deals.map(d => [d.id, d])).values()];
  if (events.length) patch.events = events;
  const changedHistory = [...history.values()].filter(series => series.points.length);
  if (changedHistory.length) patch.history = changedHistory as Snapshot['history'];
  result('融资每日检查', articles.length ? 'success' : results.some(row => row.status === 'error') ? 'error' : 'unchanged', `检查 ${requests} 个公开接口/页面；新增或补充 ${patch.deals?.length || 0} 条交易、${events.length} 条待核披露。未完整确认的周没有填零。`);
  return { patch, results };
}
