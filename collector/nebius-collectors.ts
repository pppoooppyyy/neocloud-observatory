import type { HistoryPoint, Row, Snapshot, Source, TimeSeries } from './types';

export const NEBIUS_API = 'https://api.nebius.cloud/billing/v1alpha1/spot-price';
export const NEBIUS_SOURCE: Source & { apiUrl: string; methodologyUrl: string } = {
  id: 'nebius-spot-pricing', name: 'Nebius official Spot GPU prices',
  url: 'https://nebius.com/spot-prices', kind: 'official', apiUrl: NEBIUS_API,
  methodologyUrl: 'https://docs.nebius.com/signup-billing/spot-prices',
  description: 'Nebius 官方按平台及地区的可抢占 Spot 报价，USD/GPU-hour。当前快照及原始生效时间均保留；历史按小时桶所属 UTC 日取末次桶末价（METHOD_LAST_PRICE），次日 00:00 桶归前一日。',
};
const NOTE = 'Nebius 官方可抢占 Spot 报价，USD/GPU-hour；平台与地区分列。历史按小时桶所属 UTC 日取最后一个已结束桶末价（METHOD_LAST_PRICE），次日 00:00 桶归前一日，保留原始桶末时间；缺日留空。2026-10-08 起采用动态 Spot 定价，此前为固定 PVM 价格。';
const PLATFORMS: Record<string, { model: string; title: string; form: string }> = {
  'gpu-h100-sxm': { model: 'H100', title: 'H100 NVLink', form: 'SXM' },
  'gpu-h200-sxm': { model: 'H200', title: 'H200 NVLink', form: 'SXM' },
  'gpu-b200-sxm': { model: 'B200', title: 'B200 NVLink', form: 'SXM' },
  'gpu-b200-sxm-a': { model: 'B200', title: 'B200 NVLink', form: 'SXM (platform a)' },
  'gpu-b300-sxm': { model: 'B300', title: 'B300 NVLink', form: 'SXM' },
  'gpu-rtx6000': { model: 'RTX PRO 6000', title: 'RTX PRO 6000', form: 'RTX PRO 6000' },
  'gpu-rtx6000-a': { model: 'RTX PRO 6000', title: 'RTX PRO 6000', form: 'RTX PRO 6000 (platform a)' },
};
type Result = { source: string; status: string; detail: string; latestDate?: string };
type Options = { fetch?: typeof fetch; now?: () => Date; timeoutMs?: number; nebiusHistory?: boolean };
type Product = { key: string; skuId: string; platform: string; productTitle: string; region: string; model: string; form: string; value: number; effectiveTime: string };
type Current = { items: Product[]; snapshotTime: string; nextPageToken?: string };

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: unknown): string {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/.test(value), 'Nebius 时间必须为完整 UTC 时间戳');
  const date = new Date(value);
  ensure(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10), 'Nebius 时间无效');
  return value;
}
function price(value: unknown): number {
  ensure(object(value) && value.currency === 'usd' && value.unitTitle === 'GPU hour', 'Nebius 币种或 GPU 小时单位变化');
  ensure(typeof value.value === 'string' && /^\d+(?:\.\d+)?$/.test(value.value), 'Nebius 价格不是有效十进制数');
  const amount = Number(value.value);
  ensure(Number.isFinite(amount) && amount > 0 && amount < 1000, 'Nebius 价格超出单 GPU 小时范围');
  return amount;
}
function pageToken(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  ensure(typeof value === 'string' && value.length <= 4096, 'Nebius 分页标记无效');
  return value;
}
function product(row: unknown, snapshotTime: string): Product {
  ensure(object(row) && typeof row.skuId === 'string' && /^sku-[a-z0-9]+$/.test(row.skuId), 'Nebius SKU 无效');
  ensure(typeof row.region === 'string' && /^[a-z]{2}-[a-z]+\d+$/.test(row.region), 'Nebius 地区字段无效');
  ensure(object(row.computeInstance) && typeof row.computeInstance.platform === 'string', 'Nebius 平台字段缺失');
  const platform = row.computeInstance.platform;
  const metadata = PLATFORMS[platform];
  ensure(metadata, `Nebius 未识别的平台：${platform}`);
  ensure(row.productTitle === `Preemptible NVIDIA® ${metadata.title}`, 'Nebius 产品名称与 Spot 平台不一致');
  const effectiveTime = timestamp(row.effectiveTime);
  ensure(Date.parse(effectiveTime) <= Date.parse(snapshotTime), 'Nebius 生效时间晚于来源快照');
  return { key: `nebius-${platform}-${row.region}-spot`, skuId: row.skuId, platform, productTitle: row.productTitle, region: row.region, model: metadata.model, form: metadata.form, value: price(row.price), effectiveTime };
}

/** Keep source timestamps verbatim, including sub-millisecond precision. */
export function parseNebiusCurrent(payload: unknown, observedAt: string): Current {
  timestamp(observedAt);
  ensure(object(payload) && Array.isArray(payload.items) && payload.items.length > 0 && payload.items.length <= 100, 'Nebius 当前报价列表缺失或过大');
  const snapshotTime = timestamp(payload.snapshotTime);
  ensure(Date.parse(snapshotTime) <= Date.parse(observedAt), 'Nebius 当前快照位于未来');
  ensure(Date.parse(observedAt) - Date.parse(snapshotTime) <= 24 * 60 * 60 * 1000, 'Nebius 当前快照已过期');
  const items = payload.items.map(row => product(row, snapshotTime));
  ensure(new Set(items.map(row => row.key)).size === items.length && new Set(items.map(row => row.skuId)).size === items.length, 'Nebius 当前报价含重复平台地区或 SKU');
  return { items, snapshotTime, nextPageToken: pageToken(payload.nextPageToken) };
}

/** The API timestamps label hour-bucket ends, not exact quote-change times. */
export function parseNebiusHistory(payload: unknown, products: Product[], observedAt: string): { items: { product: Product; points: HistoryPoint[] }[]; nextPageToken?: string } {
  timestamp(observedAt);
  ensure(object(payload) && Array.isArray(payload.items) && payload.items.length <= 100, 'Nebius 历史列表缺失或过大');
  const snapshotTime = timestamp(payload.snapshotTime);
  ensure(Date.parse(snapshotTime) <= Date.parse(observedAt), 'Nebius 历史响应快照位于未来');
  const seen = new Set<string>();
  const items = payload.items.map(row => {
    ensure(object(row), 'Nebius 历史报价结构无效');
    const item = products.find(item => item.skuId === row.skuId);
    ensure(item && !seen.has(item.skuId), 'Nebius 历史含未知或重复 SKU');
    seen.add(item.skuId);
    ensure(row.productTitle === item.productTitle && row.region === item.region && row.computeInstance?.platform === item.platform, 'Nebius 历史平台、地区或名称不匹配');
    ensure(row.currency === 'usd' && row.unitTitle === 'GPU hour', 'Nebius 历史币种或 GPU 小时单位变化');
    ensure(Array.isArray(row.points) && row.points.length <= 4000, 'Nebius 历史点缺失或过多');
    const days = new Map<string, HistoryPoint>(), timestamps = new Set<string>();
    for (const point of row.points) {
      ensure(object(point), 'Nebius 历史点结构无效');
      const sourceBucketEndAt = timestamp(point.timestamp);
      ensure(!timestamps.has(sourceBucketEndAt), 'Nebius 历史含重复时间戳');
      timestamps.add(sourceBucketEndAt);
      const value = price({ value: point.value, currency: row.currency, unitTitle: row.unitTitle });
      // Ignore open/future buckets; never turn them into past observations.
      if (Date.parse(sourceBucketEndAt) > Math.min(Date.parse(snapshotTime), Date.parse(observedAt))) continue;
      // An hour ending at 00:00 belongs to the preceding UTC day (23:00–24:00).
      const date = new Date(Date.parse(sourceBucketEndAt) - 1).toISOString().slice(0, 10), prior = days.get(date);
      if (!prior || Date.parse(sourceBucketEndAt) > Date.parse(prior.sourceBucketEndAt)) days.set(date, {
        date, value, observedAt, sourceSnapshotAt: snapshotTime, sourceBucketEndAt,
        sourceId: NEBIUS_SOURCE.id, kind: 'official_api_history', priceScope: 'hour_bucket_last_price',
      });
    }
    return { product: item, points: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  });
  return { items, nextPageToken: pageToken(payload.nextPageToken) };
}

async function readJson(url: string, fetcher: typeof fetch, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const limit = 2 * 1024 * 1024;
  try {
    const response = await fetcher(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'NeocloudMonitor/1.0' }, redirect: 'follow' });
    ensure(response.ok, `Nebius API HTTP ${response.status}`);
    ensure(!response.url || new URL(response.url).origin === new URL(NEBIUS_API).origin, 'Nebius API 跳转至未知来源');
    ensure(/application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || ''), 'Nebius API 返回非 JSON 内容');
    ensure(Number(response.headers.get('content-length') || 0) <= limit && response.body, 'Nebius API 内容为空或超过大小上限');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let content = '', bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        ensure(bytes <= limit, 'Nebius API 超过大小上限');
        content += decoder.decode(value, { stream: true });
      }
      return JSON.parse(content + decoder.decode());
    } finally { await reader.cancel().catch(() => {}); }
  } finally { clearTimeout(timer); }
}

function matchesMetadata(row: Row, item: Product): boolean {
  // Older public snapshot projections omit platform/SKU. The complete series key
  // remains mandatory; metadata that survives projection must still agree.
  return row.seriesKey === item.key && row.sourceId === NEBIUS_SOURCE.id && row.provider === 'Nebius' && row.model === item.model && row.region === item.region && row.market === 'spot' && row.unit === 'gpu_hour' && (row.platform === undefined || row.platform === item.platform) && (row.skuId === undefined || row.skuId === item.skuId);
}

/** Public official API. Failed reads never create a new observation date. */
export async function collectNebius(old: Snapshot, options: Options = {}): Promise<{ patch: Partial<Snapshot>; results: Result[] }> {
  const fetcher = options.fetch || globalThis.fetch, now = options.now || (() => new Date());
  const timeoutMs = Math.min(12_000, Math.max(1, options.timeoutMs || 12_000));
  const quotes: Row[] = [], history: TimeSeries[] = [], results: Result[] = [];
  const items: (Product & { snapshotTime: string })[] = [];
  let observedAt: string;
  try {
    let token: string | undefined;
    const seenTokens = new Set<string>(), seenKeys = new Set<string>(), seenSkus = new Set<string>();
    do {
      const url = new URL(NEBIUS_API);
      url.searchParams.set('pageSize', '100');
      if (token) url.searchParams.set('pageToken', token);
      const data = await readJson(url.href, fetcher, timeoutMs);
      observedAt = now().toISOString();
      const parsed = parseNebiusCurrent(data, observedAt);
      for (const item of parsed.items) {
        ensure(!seenKeys.has(item.key) && !seenSkus.has(item.skuId), 'Nebius 分页含重复报价');
        seenKeys.add(item.key); seenSkus.add(item.skuId);
        items.push({ ...item, snapshotTime: parsed.snapshotTime });
      }
      token = parsed.nextPageToken;
      if (token) {
        ensure(!seenTokens.has(token) && seenTokens.size < 10, 'Nebius 分页循环或超过安全上限');
        seenTokens.add(token);
      }
    } while (token);
  } catch (error) {
    return { patch: {}, results: [{ source: NEBIUS_SOURCE.id, status: 'error', detail: `${error instanceof Error ? error.message : 'Nebius API 采集失败'}；保留原记录日期` }] };
  }
  const date = observedAt!.slice(0, 10);
  const historical = new Map<string, HistoryPoint[]>();
  const backfillItems = items.filter(item => {
    const existing = old.history?.find(row => row.seriesKey === item.key || row.id === `price-history-${item.key}`);
    if (existing && !matchesMetadata(existing, item)) return false;
    const dates = new Set(existing?.points.map(point => point.date));
    return Array.from({ length: 29 }, (_, i) => new Date(Date.parse(`${date}T00:00:00Z`) - (i + 1) * 86400000).toISOString().slice(0, 10)).some(day => !dates.has(day));
  });
  if (options.nebiusHistory !== false && backfillItems.length) {
    try {
      // Stay inside the source's rolling 30-day limit despite request latency.
      const startTime = new Date(Date.parse(observedAt!) - 30 * 86400000 + 5 * 60000).toISOString();
      let token: string | undefined;
      const seenTokens = new Set<string>(), seenSkus = new Set<string>();
      do {
        const url = new URL(`${NEBIUS_API}/list-series`);
        url.searchParams.set('filters.startTime', startTime);
        url.searchParams.set('filters.endTime', observedAt!);
        for (const item of backfillItems) url.searchParams.append('filters.skuIds', item.skuId);
        url.searchParams.set('aggregation.granularity', 'GRANULARITY_HOUR_1');
        url.searchParams.set('aggregation.method', 'METHOD_LAST_PRICE');
        url.searchParams.set('pageSize', '100');
        if (token) url.searchParams.set('pageToken', token);
        const data = await readJson(url.href, fetcher, timeoutMs);
        const parsed = parseNebiusHistory(data, backfillItems, now().toISOString());
        for (const { product, points } of parsed.items) {
          ensure(!seenSkus.has(product.skuId), 'Nebius 历史分页含重复 SKU');
          seenSkus.add(product.skuId);
          historical.set(product.key, points.map(point => ({ ...point, sourceUrl: url.href })));
        }
        token = parsed.nextPageToken;
        if (token) {
          ensure(!seenTokens.has(token) && seenTokens.size < 10, 'Nebius 历史分页循环或超过安全上限');
          seenTokens.add(token);
        }
      } while (token);
    } catch (error) {
      historical.clear();
      results.push({ source: `${NEBIUS_SOURCE.id}-history`, status: 'warning', detail: `${error instanceof Error ? error.message : 'Nebius 历史回填失败'}；保留已有历史，当前报价继续采集` });
    }
  }
  for (const item of items) {
    const prior = old.quotes.filter(row => row.seriesKey === item.key).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
    const latest = prior[0];
    const existing = old.history?.find(row => row.seriesKey === item.key || row.id === `price-history-${item.key}`);
    if (prior.some(row => !matchesMetadata(row, item) || !Number.isFinite(Date.parse(row.observedAt))) || (existing && !matchesMetadata(existing, item))) {
      results.push({ source: item.key, status: 'error', detail: '现有 Nebius 序列平台、地区、SKU、单位或来源不匹配，未写入' });
      continue;
    }
    if (latest && Date.parse(latest.observedAt) > Date.parse(observedAt!)) {
      results.push({ source: item.key, status: 'warning', detail: '现有 Nebius 记录晚于本次观察，保留较新记录' });
      continue;
    }
    const previous = prior.find(row => String(row.observedAt).slice(0, 10) < date);
    const metadata = { provider: 'Nebius', sourceId: NEBIUS_SOURCE.id, model: item.model, form: item.form, platform: item.platform, skuId: item.skuId, productTitle: item.productTitle, region: item.region, market: 'spot', unit: 'gpu_hour', seriesKey: item.key };
    quotes.push({ ...latest, ...metadata, id: `${item.key}-${date.replaceAll('-', '')}`, usdPerHour: item.value, observedAt,
      effectiveFrom: item.effectiveTime.slice(0, 10), sourceEffectiveAt: item.effectiveTime, sourceSnapshotAt: item.snapshotTime,
      previousUsdPerHour: previous?.usdPerHour ?? null, previousDate: previous ? String(previous.observedAt).slice(0, 10) : null,
      scopeNote: NOTE, observationKind: 'official_api_read', sourceUrl: `${NEBIUS_API}?pageSize=100`,
    });
    const priorDates = new Set(existing?.points.map(point => point.date));
    const points: HistoryPoint[] = (historical.get(item.key) || []).filter(point => point.date < date && !priorDates.has(point.date));
    points.push({ date, value: item.value, observedAt, sourceSnapshotAt: item.snapshotTime, sourceEffectiveAt: item.effectiveTime, kind: 'official_api_read', sourceId: NEBIUS_SOURCE.id, sourceUrl: `${NEBIUS_API}?pageSize=100` });
    history.push({ ...existing, ...metadata, id: existing?.id || `price-history-${item.key}`, label: `Nebius ${item.model} · ${item.platform} · ${item.region} · Spot`, metric: 'supplier_price', frequency: 'daily', method: 'observation', description: NOTE, points });
    results.push({ source: item.key, status: 'success', latestDate: date, detail: `${item.value} USD/GPU小时；${item.region}；Spot 官方 API 观察` });
  }
  return { patch: quotes.length ? { sources: [NEBIUS_SOURCE], quotes, history } : {}, results };
}
