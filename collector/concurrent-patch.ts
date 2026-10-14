import type { Snapshot } from './types';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Never replace a point or row revised by an analyst while a collector was running. */
export function concurrentPatch(before: Snapshot, current: Snapshot, incoming: Partial<Snapshot>): Partial<Snapshot> {
  const patch: any = {};
  const previousSources = new Map(before.sources.map(row => [row.id, row]));
  const changedSources = new Set(current.sources.filter(row => {
    const old: any = previousSources.get(row.id);
    return !old || ['url', 'apiUrl', 'methodologyUrl'].some(key => !equal(old[key], (row as any)[key]));
  }).map(row => row.id));
  const validSources = (row: any) => ![row.sourceId, row.primarySourceId, row.dateEvidenceSourceId, row.rankedSourceId, row.treasurySourceId, row.quote?.sourceId, row.quote?.treasurySourceId, ...(row.identifierSourceIds || [])].some(id => changedSources.has(id));
  for (const key of ['sources', 'quotes', 'deals', 'bonds', 'events', 'treasury'] as const) {
    if (!incoming[key]) continue;
    const id = key === 'treasury' ? 'date' : 'id';
    const old = new Map(((before as any)[key] || []).map((row: any) => [row[id], row]));
    const now = new Map(((current as any)[key] || []).map((row: any) => [row[id], row]));
    patch[key] = (incoming[key] as any[]).filter(row => equal(old.get(row[id]), now.get(row[id])) && validSources(row));
  }
  for (const key of ['series', 'history'] as const) {
    if (!incoming[key]) continue;
    const old = new Map((before[key] || []).map(row => [row.id, row]));
    const now = new Map((current[key] || []).map(row => [row.id, row]));
    patch[key] = [];
    for (const row of incoming[key] || []) {
      const previous = old.get(row.id), present = now.get(row.id);
      if (!validSources(row)) continue;
      if (!previous && !present) { patch[key].push({ ...row, points: row.points.filter(validSources) }); continue; }
      if (!previous || !present || previous.sourceId !== present.sourceId) continue;
      const semanticFields = ['provider', 'model', 'unit', 'region', 'market', 'aggregation', 'apiModel', 'metric', 'frequency', 'method', 'seriesKey', 'form'];
      if (semanticFields.some(field => !equal((previous as any)[field], (present as any)[field]))) continue;
      const oldPoints = new Map(previous.points.map(point => [point.date, point]));
      const nowPoints = new Map(present.points.map(point => [point.date, point]));
      const points = row.points.filter(point => equal(oldPoints.get(point.date), nowPoints.get(point.date)) && validSources(point));
      const { points: _old, ...oldMeta } = previous;
      const { points: _now, ...nowMeta } = present;
      const merged: any = { ...(equal(oldMeta, nowMeta) ? { ...present, ...row } : present), points };
      if (key === 'series') {
        const asOf = [...present.points, ...points].reduce((last, point) => point.date > last ? point.date : last, '');
        merged.asOf = asOf;
        merged.sourceUpdatedAt = asOf;
      }
      patch[key].push(merged);
    }
  }
  return patch;
}
