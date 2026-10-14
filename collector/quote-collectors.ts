import type { Row, Snapshot, Source, TimeSeries } from './types';

type QuoteResult = { source: string; status: string; detail: string; latestDate?: string };
type QuoteOptions = { fetch?: typeof fetch; now?: () => Date; timeoutMs?: number };
type ParsedPrices = { prices: Record<string, number>; errors: Record<string, string> };
type Product = { key: string; model: string; unit: string; market: string };

const SOURCES: Source[] = [
  { id: 'google-tpu-pricing', name: 'Google Cloud TPU pricing', url: 'https://cloud.google.com/tpu/pricing', kind: 'official' },
  { id: 'jarvis-pricing', name: 'Jarvis Labs pricing', url: 'https://jarvislabs.ai/pricing', kind: 'official' },
  { id: 'runpod-pricing', name: 'Runpod pricing', url: 'https://www.runpod.io/pricing', kind: 'official' },
  { id: 'spheron-pricing', name: 'Spheron GPU rental pricing', url: 'https://www.spheron.network/gpu-rental/', kind: 'official' },
];
const PRODUCTS: Record<string, Product[]> = {
  'google-tpu-pricing': ['us-east1', 'us-east5'].flatMap(region => [
    { key: `google-trillium-${region}-on-demand`, model: 'Trillium (TPU v6e)', market: 'on_demand', unit: 'chip_hour' },
    { key: `google-trillium-${region}-flex-start`, model: 'Trillium (TPU v6e)', market: 'flex_start', unit: 'chip_hour' },
  ]),
  'jarvis-pricing': ['h100', 'h200'].map(model => ({ key: `jarvis-${model}-sxm-on-demand-all-regions`, model: model.toUpperCase(), market: 'on_demand', unit: 'gpu_hour' })),
  'runpod-pricing': ['h100-sxm', 'h100-pcie', 'h100-nvl', 'h200'].map(model => ({ key: `runpod-secure-${model}-on-demand`, model: model.startsWith('h100') ? 'H100' : 'H200', market: 'on_demand', unit: 'gpu_hour' })),
  'spheron-pricing': ['h100', 'h200'].flatMap(model => ['on-demand', 'spot'].map(market => ({ key: `spheron-${model}-${market}`, model: model.toUpperCase(), market: market.replace('-', '_'), unit: 'gpu_hour' }))),
};
const NOTES: Record<string, string> = {
  'google-tpu-pricing': '官方小时价；USD/芯片小时。地区、按需与 DWS Flex-start 分列；采集日是页面观察日，未推定价格生效日。',
  'jarvis-pricing': '官方 USD 单卡按需目录价；SXM、每 GPU 小时，按分钟计费。网页未提供地区选择，本序列沿用原有供应商口径；新观察不推定全地区成交价。',
  'runpod-pricing': '官方 Pods Secure Cloud 按需目录价，USD/GPU 小时；未锁定地区，排除 Community、Serverless、Clusters 及长期合约。',
  'spheron-pricing': '官方公开 GPU 目录，USD/GPU 小时；按需与 Spot 分列，未锁定地区或供应商。仅记录本次页面 initialPricing 字段，不用 lastKnownRates 补空。',
};

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function clean(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(style|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
}
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&dollar;|&#36;/gi, '$').replace(/\s+/g, ' ').trim();
}
function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2];
}
function positive(value: string): number {
  ensure(/^\d+(?:\.\d+)?$/.test(value.trim()), '价格不是有效数字');
  const result = Number(value);
  ensure(Number.isFinite(result) && result > 0 && result < 1000, '价格超出单卡小时有效范围');
  return result;
}
function usdHour(value: string, allowBare = false): number {
  const expression = allowBare ? /^\$(\d+(?:\.\d+)?)(?:\s*\/\s*(?:1\s*)?(?:hr|hour))?$/i : /^\$(\d+(?:\.\d+)?)\s*\/\s*(?:1\s*)?(?:hr|hour)$/i;
  const match = expression.exec(value.trim());
  ensure(match, '缺少明确的美元每小时单位');
  return positive(match[1]);
}
function one<T>(items: T[], label: string): T {
  ensure(items.length === 1, `${label} 缺失或重复，拒绝猜测价格`);
  return items[0];
}

/** Extract only current, contract-specific public page fields; never evaluate scripts. */
export function parseQuotePage(sourceId: string, html: string): ParsedPrices {
  const result: ParsedPrices = { prices: {}, errors: {} };
  const take = (key: string, read: () => number) => {
    try { result.prices[key] = read(); }
    catch (error) { result.errors[key] = error instanceof Error ? error.message : '报价解析失败'; }
  };
  const visible = clean(html);
  if (sourceId === 'google-tpu-pricing') {
    ensure(/per chip-hour in USD/i.test(text(visible)), 'Google TPU 币种或每芯片小时口径未确认');
    const hourly = [...visible.matchAll(/<button\b[^>]*>/gi)].some(([tag]) => attr(tag, 'aria-label') === 'Hourly' && attr(tag, 'aria-checked') === 'true');
    ensure(hourly, 'Google TPU 小时模式未激活');
    const table = one([...visible.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]).filter(table => /Cloud TPU Version/i.test(text(table)) && /DWS Flex-start price/i.test(text(table))), 'Google TPU 定价表');
    // Expand rowspans so the second Trillium region cannot inherit another TPU model.
    const rows: string[][] = [];
    const carry = new Map<number, { value: string; remaining: number }>();
    for (const [, rowHtml] of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row: string[] = [];
      for (const [column, item] of carry) {
        row[column] = item.value;
        if (--item.remaining === 0) carry.delete(column);
      }
      let column = 0;
      for (const [, tag, cellHtml] of rowHtml.matchAll(/<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi)) {
        while (row[column] !== undefined) column++;
        const colspan = Number(attr(tag, 'colspan') || 1);
        const rowspan = Number(attr(tag, 'rowspan') || 1);
        ensure(Number.isInteger(colspan) && colspan === 1 && Number.isInteger(rowspan) && rowspan >= 1 && rowspan <= 30, 'Google TPU 表格结构发生变化');
        row[column] = text(cellHtml);
        if (rowspan > 1) carry.set(column, { value: row[column], remaining: rowspan - 1 });
        column++;
      }
      rows.push(row);
    }
    const headers = one(rows.filter(row => /Cloud TPU Version/i.test(row[0] || '')), 'Google TPU 表头');
    const regionColumn = headers.findIndex(value => /^Region$/i.test(value));
    const demandColumn = headers.findIndex(value => /^On Demand \(USD\)/i.test(value));
    const flexColumn = headers.findIndex(value => /^DWS Flex-start price \(USD\)/i.test(value));
    ensure(regionColumn >= 0 && demandColumn >= 0 && flexColumn >= 0, 'Google TPU 列名或币种变化');
    for (const region of ['us-east1', 'us-east5']) {
      for (const [market, column] of [['on-demand', demandColumn], ['flex-start', flexColumn]] as const) {
        take(`google-trillium-${region}-${market}`, () => {
          const row = one(rows.filter(row => /^Trillium(?: \(.*\))?$/.test(row[0] || '') && row[regionColumn] === region), `Trillium ${region}`);
          return usdHour(row[column] || '', true);
        });
      }
    }
  } else if (sourceId === 'jarvis-pricing') {
    const buttons = [...visible.matchAll(/<button\b[^>]*>/gi)].map(match => match[0]);
    ensure(buttons.some(tag => attr(tag, 'id') === 'plan-tab-on-demand' && attr(tag, 'aria-selected') === 'true'), 'Jarvis 按需页签未选中');
    const panel = [...visible.matchAll(/<div\b[^>]*>/gi)].find(([tag]) => attr(tag, 'id') === 'plan-panel' && attr(tag, 'aria-labelledby') === 'plan-tab-on-demand');
    ensure(panel, 'Jarvis 按需价格面板缺失');
    ensure(/Per GPU per hour/i.test(text(visible)) && /\bUSD\b/.test(text(visible)), 'Jarvis 美元单卡小时口径未确认');
    const sections = [...visible.slice(panel.index).matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3\b|$)/gi)];
    for (const model of ['H100', 'H200']) {
      take(`jarvis-${model.toLowerCase()}-sxm-on-demand-all-regions`, () => {
        const matches = sections.filter(match => text(match[1]) === `NVIDIA ${model} SXM`);
        ensure(matches.length >= 1 && matches.length <= 2, `Jarvis ${model} SXM 价格行缺失或结构变化`);
        // The official page renders both desktop and mobile cards; they must agree.
        const values = matches.map(([, , section]) => {
          const selected = [...section.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].filter(match => attr(match[1], 'aria-pressed') === 'true');
          ensure(selected.length === 1 && /^1\s*×$/.test(text(selected[0][2])), 'Jarvis 不是单 GPU 选择');
          ensure(/On-demand\s*·\s*\/hr/i.test(text(section)), 'Jarvis 按需小时单位缺失');
          const amounts = [...text(section).matchAll(/\$\s*(\d+(?:\.\d+)?)/g)];
          return positive(one(amounts, `Jarvis ${model} 单卡美元价`)[1]);
        });
        ensure(new Set(values).size === 1, 'Jarvis 桌面和移动版价格不一致');
        return values[0];
      });
    }
  } else if (sourceId === 'runpod-pricing') {
    const rows = [...visible.matchAll(/<div\b[^>]*class=["'][^"']*\bgpu_table-row\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bgpu_table-row\b|$)/gi)].map(match => match[1]);
    ensure(rows.length > 0, 'Runpod Pods 价格表缺失');
    for (const [name, key] of [['H100 SXM', 'h100-sxm'], ['H100 PCIe', 'h100-pcie'], ['H100 NVL', 'h100-nvl'], ['H200', 'h200']]) {
      take(`runpod-secure-${key}-on-demand`, () => {
        const row = one(rows.filter(row => {
          const nameTag = /<p\b[^>]*class=["'][^"']*\bgpu_name\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(row);
          return nameTag && text(nameTag[1]) === name;
        }), `Runpod ${name}`);
        const priceTag = one([...row.matchAll(/<div\b([^>]*\bdata-secure\s*=[^>]*)>([\s\S]*?)<\/div>/gi)], `Runpod ${name} Secure`);
        ensure(attr(priceTag[1], 'class')?.split(/\s+/).includes('gpu_table-price'), 'Runpod 非 Pods 价格字段');
        ensure(/^\$\s*\d+(?:\.\d+)?\s*\/hr$/.test(text(priceTag[2])), 'Runpod 美元小时单位缺失');
        const price = attr(priceTag[1], 'data-secure');
        ensure(price !== undefined, 'Runpod Secure 价格缺失');
        return positive(price);
      });
    }
  } else if (sourceId === 'spheron-pricing') {
    const dataTag = one([...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(match => attr(match[1], 'id') === '__NEXT_DATA__' && attr(match[1], 'type') === 'application/json'), 'Spheron 公开目录数据');
    const data = JSON.parse(dataTag[2]);
    const rows = data?.props?.pageProps?.initialPricing;
    ensure(Array.isArray(rows), 'Spheron 当前目录缺失');
    for (const model of ['H100', 'H200']) {
      for (const [market, field] of [['on-demand', 'onDemandPrice'], ['spot', 'spotPrice']]) {
        take(`spheron-${model.toLowerCase()}-${market}`, () => {
          const row = one(rows.filter(row => row?.name === model && row?.slug === model.toLowerCase() && row?.vendor === 'NVIDIA'), `Spheron ${model}`);
          ensure(String(row.specs?.vram) === (model === 'H100' ? '80' : '141'), 'Spheron 显存规格变化');
          ensure(typeof row[field] === 'string', `Spheron ${market} 当前价格缺失`);
          return usdHour(row[field]);
        });
      }
    }
  } else throw new Error('未知官方报价来源');
  return result;
}

async function readPage(source: Source, fetcher: typeof fetch, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const maxBytes = 5 * 1024 * 1024;
  try {
    const response = await fetcher(source.url, { signal: controller.signal, headers: { Accept: 'text/html', 'User-Agent': 'NeocloudMonitor/1.0' }, redirect: 'follow' });
    ensure(response.ok, `官方页面 HTTP ${response.status}`);
    ensure(!response.url || new URL(response.url).hostname.replace(/^www\./, '') === new URL(source.url).hostname.replace(/^www\./, ''), '官方页面重定向至未知域名');
    ensure(/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || ''), '官方页面返回非 HTML 内容');
    ensure(Number(response.headers.get('content-length') || 0) <= maxBytes, '页面超过大小上限');
    ensure(response.body, '官方页面无内容');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '', bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        ensure(bytes <= maxBytes, '页面超过大小上限');
        content += decoder.decode(value, { stream: true });
      }
      return content + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  } finally { clearTimeout(timer); }
}

/** Four public reads, at most four concurrent requests. A failed quote emits no new date or value. */
export async function collectQuotes(old: Snapshot, options: QuoteOptions = {}): Promise<{ patch: Partial<Snapshot>; results: QuoteResult[] }> {
  const fetcher = options.fetch || globalThis.fetch;
  const now = options.now || (() => new Date());
  const timeoutMs = Math.min(12_000, Math.max(1, options.timeoutMs || 12_000));
  const outcomes = await Promise.all(SOURCES.map(async source => {
    const quotes: Row[] = [];
    const history: TimeSeries[] = [];
    const results: QuoteResult[] = [];
    try {
      const parsed = parseQuotePage(source.id, await readPage(source, fetcher, timeoutMs));
      const observedAt = now().toISOString();
      const date = observedAt.slice(0, 10);
      for (const product of PRODUCTS[source.id]) {
        const prior = old.quotes.filter(row => row.seriesKey === product.key).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
        const latest = prior[0];
        const price = parsed.prices[product.key];
        const googleRegion = source.id === 'google-tpu-pricing' ? /-(us-east[15])-/.exec(product.key)?.[1] : null;
        if (!latest || latest.sourceId !== source.id || latest.model !== product.model || latest.market !== product.market || latest.unit !== product.unit || (googleRegion && latest.region !== googleRegion) || !Number.isFinite(Date.parse(latest.observedAt))) {
          results.push({ source: product.key, status: 'error', detail: '现有序列型号、合约、单位或来源不匹配，未写入' });
          continue;
        }
        if (price === undefined) {
          results.push({ source: product.key, status: 'error', detail: parsed.errors[product.key] || '官方报价缺失，保留原记录日期' });
          continue;
        }
        if (Date.parse(latest.observedAt) > Date.parse(observedAt)) {
          results.push({ source: product.key, status: 'warning', detail: '现有记录晚于本次观察时刻，保留较新记录' });
          continue;
        }
        const previous = prior.find(row => String(row.observedAt).slice(0, 10) < date);
        const quote: Row = {
          ...latest, id: `${product.key}-${date.replaceAll('-', '')}`, usdPerHour: price, observedAt,
          effectiveFrom: price === latest.usdPerHour ? latest.effectiveFrom ?? null : null,
          previousUsdPerHour: previous?.usdPerHour ?? null, previousDate: previous ? String(previous.observedAt).slice(0, 10) : null,
          scopeNote: NOTES[source.id], observationKind: 'official_page_read', sourceUrl: source.url,
        };
        quotes.push(quote);
        const existingHistory = old.history?.find(row => row.seriesKey === product.key || row.id === `price-history-${product.key}`);
        history.push({
          ...existingHistory, id: existingHistory?.id || `price-history-${product.key}`,
          label: existingHistory?.label || `${latest.provider} ${latest.model}`,
          sourceId: source.id, unit: product.unit, metric: product.unit === 'chip_hour' ? 'tpu_price' : 'supplier_price',
          frequency: 'daily', method: 'observation', seriesKey: product.key,
          provider: latest.provider, model: latest.model, form: latest.form, region: latest.region, market: product.market,
          description: NOTES[source.id],
          points: [{ date, value: price, observedAt, kind: 'official_page_read', sourceId: source.id, sourceUrl: source.url }],
        });
        results.push({ source: product.key, status: 'success', latestDate: date, detail: `${price} USD/${product.unit === 'chip_hour' ? '芯片' : 'GPU'}小时；${product.market}；官方页面当日观察` });
      }
    } catch (error) {
      results.push({ source: source.id, status: 'error', detail: `${error instanceof Error ? error.message : '官方页面采集失败'}；保留原记录日期` });
    }
    return { quotes, history, results, sources: quotes.length ? [{ ...old.sources.find(row => row.id === source.id), ...source }] : [] };
  }));
  const sources = outcomes.flatMap(row => row.sources);
  const quotes = outcomes.flatMap(row => row.quotes);
  const history = outcomes.flatMap(row => row.history);
  return { patch: quotes.length ? { sources, quotes, history } : {}, results: outcomes.flatMap(row => row.results) };
}
