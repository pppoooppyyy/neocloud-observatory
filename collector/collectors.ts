import type {IndexSeries, Point, Snapshot} from "./types";

type CollectionResult = {source:string;status:string;detail:string;latestDate?:string};
type ObjectValue = Record<string, unknown>;
type CatalogModel = {gpuModel:string;displayName:string};
const TIMEOUT_MS = 12_000;
const MAX_CONCURRENCY = 4;
const ORNN_MODELS = new Set(["H100 SXM", "H200", "B200", "A100 SXM4", "RTX 5090"]);

class ObservationWarning extends Error {}

function object(value:unknown, context:string):ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context}格式不符`);
  return value as ObjectValue;
}

function successBody(value:unknown):ObjectValue {
  const body = object(value, "接口响应");
  if (body.success !== true) throw new Error("接口未返回success=true");
  if (!Array.isArray(body.data) || body.data.length === 0) throw new Error("接口无有效数据，保留旧记录");
  return body;
}

function positiveNumber(value:unknown):number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("价格必须为正有限数值");
  return value;
}

function utcTimestamp(value:unknown, midnight=false):number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|\+00:00)$/.test(value)) {
    throw new Error("日期必须为完整UTC时间戳");
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error("日期无效");
  }
  if (midnight && time % 86_400_000 !== 0) throw new Error("Mercatus日线日期必须为UTC零点");
  if (time > Date.now()) throw new Error("接口包含未来观测日期");
  return time;
}

function sortedPoints(points:Point[]):Point[] {
  const dates = new Set<string>();
  for (const point of points) {
    if (dates.has(point.date)) throw new Error("同一日存在重复观测，保留旧记录");
    dates.add(point.date);
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

function parseOrnn(value:unknown, model:string):Point[] {
  const body = successBody(value);
  if (body.gpu_type !== model) throw new Error("Ornn返回型号与请求不符");
  // Ornn does not return currency/unit metadata. Reject a conflict if it adds them.
  if (body.currency !== undefined && body.currency !== "USD") throw new Error("Ornn币种改变");
  if (body.priceUnit !== undefined && body.priceUnit !== "per_gpu_hour") throw new Error("Ornn价格单位改变");
  const points = (body.data as unknown[]).map(value => {
    const row = object(value, "Ornn数据行");
    const time = utcTimestamp(row.timestamp);
    const stamp = new Date(time);
    if (![20, 21].includes(stamp.getUTCHours()) || stamp.getUTCMinutes() !== 0 || stamp.getUTCSeconds() !== 0 || stamp.getUTCMilliseconds() !== 0) {
      throw new ObservationWarning("Ornn每日时间戳不在20:00/21:00 UTC；暂停导入该序列，需核对台北日期映射");
    }
    return {date:new Date(time + 8 * 3_600_000).toISOString().slice(0, 10),value:positiveNumber(row.index_value)};
  });
  return sortedPoints(points);
}

function parseCatalog(value:unknown):CatalogModel[] {
  const body = successBody(value);
  const ids = new Set<string>();
  const names = new Set<string>();
  return (body.data as unknown[]).map(value => {
    const row = object(value, "Mercatus型号目录");
    const {gpuModel, displayName} = row;
    if (typeof gpuModel !== "string" || !gpuModel.trim() || gpuModel !== gpuModel.trim() || typeof displayName !== "string" || !displayName.trim() || displayName !== displayName.trim()) {
      throw new Error("Mercatus型号目录缺少有效标识");
    }
    if (ids.has(gpuModel) || names.has(displayName)) throw new Error("Mercatus目录型号重复");
    ids.add(gpuModel);
    names.add(displayName);
    return {gpuModel, displayName};
  });
}

function parseMercatus(value:unknown, model:string):Point[] {
  const body = successBody(value);
  const meta = object(body.meta, "Mercatus元数据");
  for (const [key, expected] of Object.entries({gpuModel:model,currency:"USD",priceUnit:"per_gpu_hour",timezone:"UTC"})) {
    if (meta[key] !== expected) throw new Error(`Mercatus ${key}与预期不符`);
  }
  const rows = body.data as unknown[];
  if (!Number.isInteger(meta.dataPoints) || meta.dataPoints !== rows.length) throw new Error("Mercatus观测点数与数据长度不符");
  if (typeof meta.days !== "number" || !Number.isInteger(meta.days) || meta.days < 1 || meta.days > 90) throw new Error("Mercatus返回窗口不符");
  const range = object(meta.dateRange, "Mercatus日期范围");
  const from = utcTimestamp(range.from, true);
  const to = utcTimestamp(range.to, true);
  if (from > to) throw new Error("Mercatus日期范围颠倒");
  const points = sortedPoints(rows.map(value => {
    const row = object(value, "Mercatus数据行");
    const time = utcTimestamp(row.date, true);
    if (row.timestamp !== undefined && (typeof row.timestamp !== "number" || !Number.isInteger(row.timestamp) || row.timestamp * 1000 !== time)) throw new Error("Mercatus两种时间戳不一致");
    if (time < from || time > to) throw new Error("Mercatus观测日期超出声明范围");
    return {date:new Date(time).toISOString().slice(0, 10),value:positiveNumber(row.price)};
  }));
  if (points[0].date !== new Date(from).toISOString().slice(0, 10) || points.at(-1)!.date !== new Date(to).toISOString().slice(0, 10)) throw new Error("Mercatus日期范围与实际观测不符");
  return points;
}

function limitedFetcher() {
  let active = 0;
  const queue:Array<() => void> = [];
  async function acquire() {
    if (active < MAX_CONCURRENCY) { active++; return; }
    await new Promise<void>(resolve => queue.push(resolve));
  }
  function release() {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
  return async (url:string):Promise<unknown> => {
    await acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {headers:{Accept:"application/json"},signal:controller.signal,cache:"no-store"});
      if (!response.ok) throw new Error(`接口HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new Error("接口超过12秒未完成，保留旧记录");
      throw error;
    } finally {
      clearTimeout(timer);
      release();
    }
  };
}

function failure(source:string, error:unknown):CollectionResult {
  return {source,status:error instanceof ObservationWarning ? "warning" : "error",detail:error instanceof Error ? error.message : "接口读取失败，保留旧记录"};
}

export async function collectIndices(old:Snapshot):Promise<{series:IndexSeries[];results:CollectionResult[];updatedCount:number}> {
  const request = limitedFetcher();
  const series:IndexSeries[] = [];
  const results:CollectionResult[] = [];
  let updatedCount = 0;

  async function collect(config:IndexSeries, model:string, url:string, parse:(value:unknown, model:string) => Point[]) {
    try {
      if (config.unit !== "usd_per_gpu_hour") throw new Error("已配置序列的价格单位不符");
      const points = parse(await request(url), model);
      const prior = new Map(config.points.map(point => [point.date, point.value]));
      const changed = points.filter(point => prior.get(point.date) !== point.value).length;
      const latestDate = points.at(-1)!.date;
      const priorLatest = config.points.reduce((last, point) => point.date > last ? point.date : last, "");
      const observedAt = new Date().toISOString();
      const incoming = {...config,points,observedAt,apiModel:model,apiUrl:url,asOf:latestDate,fetchedPointCount:points.length,fetchError:null};
      series.push(incoming);
      updatedCount += changed;
      results.push({
        source:config.label,
        status:latestDate < priorLatest ? "warning" : changed ? "success" : "unchanged",
        detail:latestDate < priorLatest
          ? `接口最新日期退回${latestDate}；仅合并有效返回点，旧历史仍保留`
          : `读取${points.length}个有效日点，新增或修订${changed}个；最新源日期${latestDate}`,
        latestDate,
      });
    } catch (error) {
      results.push(failure(config.label, error));
    }
  }

  const mercatus = old.series.filter(item => item.sourceId === "mercatus");
  const mercatusTask = (async () => {
    if (!mercatus.length) return;
    let catalog:CatalogModel[];
    try {
      catalog = parseCatalog(await request("https://api.mercatus-ai.com/v1/gpu/models"));
    } catch (error) {
      results.push(failure("Mercatus 型号目录", error));
      return;
    }
    await Promise.all(mercatus.map(async config => {
      const entry = config.apiModel
        ? catalog.find(model => model.gpuModel === config.apiModel)
        : catalog.find(model => model.displayName === config.model || model.gpuModel === config.model);
      if (!entry || (config.model !== entry.displayName && config.model !== entry.gpuModel)) {
        results.push(failure(config.label, new Error("已配置型号与Mercatus官方目录不匹配，保留旧记录")));
        return;
      }
      const params = new URLSearchParams({gpuModel:entry.gpuModel,days:"90"});
      await collect(config, entry.gpuModel, `https://api.mercatus-ai.com/v1/gpu/index?${params}`, parseMercatus);
    }));
  })();

  const ornnTasks = old.series.filter(item => item.sourceId === "ornn").map(async config => {
    const model = config.apiModel || config.model;
    if (!ORNN_MODELS.has(model) || config.model !== model) {
      results.push(failure(config.label, new Error("Ornn已配置型号不在免费采集范围，保留旧记录")));
      return;
    }
    await collect(config, model, `https://api.ornnai.com/api/gpu/${encodeURIComponent(model)}/index-history`, parseOrnn);
  });
  await Promise.all([mercatusTask, ...ornnTasks]);
  series.sort((a, b) => a.id.localeCompare(b.id));
  results.sort((a, b) => a.source.localeCompare(b.source));
  return {series,results,updatedCount};
}
