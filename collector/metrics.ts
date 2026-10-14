import type { IndexSeries, Point, Row, Snapshot } from './types';

export const isoDay = (value: string) => value?.slice(0, 10) || '';

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isObservationDate(value: unknown): value is string {
  if (isCalendarDate(value)) return true;
  if (typeof value !== 'string' || !isCalendarDate(value.slice(0, 10)))
    return false;
  return (
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function ageDays(value: string, now = Date.now()) {
  if (!isObservationDate(value) || !Number.isFinite(now)) return NaN;
  return Math.max(
    0,
    Math.floor((now - Date.parse(isoDay(value) + 'T00:00:00Z')) / 86400000),
  );
}
export function latest(series?: IndexSeries) {
  return series?.points?.at(-1);
}

export function changeAt(points: Point[], days: number) {
  const end = points.at(-1);
  if (
    !end ||
    !isCalendarDate(end.date) ||
    !Number.isFinite(days) ||
    days < 0 ||
    !Number.isFinite(end.value)
  )
    return null;
  const target = new Date(Date.parse(end.date + 'T00:00:00Z') - days * 86400000)
    .toISOString()
    .slice(0, 10);
  const base = points.find((p) => p.date === target);
  return base && Number.isFinite(base.value) && base.value > 0
    ? (end.value / base.value - 1) * 100
    : null;
}

export function weekly(points: Point[]) {
  const buckets = new Map<string, Point[]>();
  for (const p of points) {
    if (!isCalendarDate(p.date) || !Number.isFinite(p.value) || p.value <= 0)
      continue;
    const d = new Date(p.date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const k = d.toISOString().slice(0, 10);
    buckets.set(k, [...(buckets.get(k) || []), p]);
  }
  return [...buckets]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, pts]) => ({
      date,
      value: pts.reduce((a, b) => a + b.value, 0) / pts.length,
      days: pts.length,
    }));
}

// source_window is eligible only for source-window aggregates; calendar-day
// aggregates must additionally require dateBasis === "announcement".
export function fundingEligible(d: Row) {
  return (
    d.includeInNewEquity === true &&
    d.transactionType === 'primary_equity' &&
    d.amountBasis === 'single_round' &&
    (d.dateBasis === 'announcement' || d.dateBasis === 'source_window')
  );
}
export function fundingTotal(deals: Row[]) {
  return deals
    .filter(fundingEligible)
    .reduce(
      (s, d) =>
        s +
        (Number.isFinite(d.amountUsdM) && d.amountUsdM > 0 ? d.amountUsdM : 0),
      0,
    );
}
export function sourcesFor(data: Snapshot, id?: string) {
  return data.sources.find((s) => s.id === id);
}
export function mergeRows(a: Row[], b: Row[]) {
  const rows = new Map(a.map((row) => [row.id, row]));
  for (const patch of b)
    rows.set(patch.id, { ...rows.get(patch.id), ...patch });
  return [...rows.values()];
}

export function validateReferences(data: Snapshot): string | null {
  const ids = new Set(data.sources.map((source) => source.id));
  const rows: Row[] = [
    ...data.series,
    ...data.quotes,
    ...data.deals,
    ...data.bonds,
    ...data.events,
    ...(data.treasury || []),
    ...(data.history || []),
  ];
  for (const row of rows) {
    const refs = [row.sourceId, row.primarySourceId, row.dateEvidenceSourceId];
    if (row.identifierSourceIds != null) {
      if (!Array.isArray(row.identifierSourceIds))
        return 'identifierSourceIds must be an array';
      refs.push(...row.identifierSourceIds);
    }
    if (Array.isArray(row.points))
      for (const p of row.points) {
        if (p.sourceId) refs.push(p.sourceId);
        if (p.treasurySourceId) refs.push(p.treasurySourceId);
      }
    if (row.quote != null)
      refs.push(row.quote.sourceId, row.quote.treasurySourceId);
    for (const ref of refs) {
      if (ref != null && (!nonempty(ref) || !ids.has(ref)))
        return 'Unknown sourceId: ' + String(ref);
    }
  }
  return null;
}

export function mergeSnapshot(
  old: Snapshot,
  patch: Partial<Snapshot>,
): Snapshot {
  const out = { ...old };
  for (const k of ['sources', 'quotes', 'deals', 'bonds', 'events'] as const) {
    if (patch[k]) (out as any)[k] = mergeRows(old[k], patch[k]!);
  }
  if (patch.series) {
    const map = new Map(old.series.map((s) => [s.id, s]));
    for (const s of patch.series) {
      const prior = map.get(s.id);
      const points = [
        ...new Map(
          [...(prior?.points || []), ...s.points].map((p) => [p.date, p]),
        ).values(),
      ].sort((a, b) => a.date.localeCompare(b.date));
      map.set(s.id, { ...prior, ...s, points });
    }
    out.series = [...map.values()];
  }
  if (patch.history) {
    const map = new Map((old.history || []).map((s) => [s.id, s]));
    for (const s of patch.history) {
      const prior = map.get(s.id);
      const points = [
        ...new Map(
          [...(prior?.points || []), ...s.points].map((p) => [p.date, p]),
        ).values(),
      ].sort((a, b) => a.date.localeCompare(b.date));
      map.set(s.id, { ...prior, ...s, points });
    }
    out.history = [...map.values()];
  }
  if (patch.treasury) {
    out.treasury = [
      ...new Map(
        [...(old.treasury || []), ...patch.treasury].map((row) => [
          row.date,
          row,
        ]),
      ).values(),
    ].sort((a, b) => a.date.localeCompare(b.date));
  }
  if (patch.schedule) out.schedule = patch.schedule;
  return out;
}

export function validatePatch(patch: any): string | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    return 'Expected JSON object';
  const allowed = [
    'sources',
    'series',
    'quotes',
    'deals',
    'bonds',
    'events',
    'treasury',
    'history',
    'schedule',
  ];
  if (Object.keys(patch).some((k) => !allowed.includes(k)))
    return 'Unknown field';
  const dateFields = [
    'date',
    'announcementDate',
    'cashDate',
    'reportDate',
    'sourceWindowStart',
    'sourceWindowEnd',
    'maturity',
    'previousDate',
    'effectiveFrom',
    'asOf',
  ];
  for (const key of allowed.filter((k) => k !== 'schedule')) {
    if (patch[key] === undefined) continue;
    if (!Array.isArray(patch[key]) || patch[key].length > 5000)
      return `Invalid ${key}`;
    const ids = new Set<string>();
    for (const r of patch[key]) {
      if (key === 'treasury') {
        if (
          !r ||
          !isCalendarDate(r.date) ||
          ids.has(r.date) ||
          !nonempty(r.sourceId) ||
          ![r.year3Pct, r.year5Pct, r.year7Pct, r.year10Pct].every(
            Number.isFinite,
          )
        )
          return 'Treasury requires unique valid dates, four finite yields and source';
        ids.add(r.date);
        continue;
      }
      if (
        !r ||
        typeof r !== 'object' ||
        Array.isArray(r) ||
        !nonempty(r.id) ||
        ids.has(r.id)
      )
        return `Missing or duplicate id in ${key}`;
      ids.add(r.id);
      for (const field of dateFields) {
        if (r[field] != null && !isCalendarDate(r[field]))
          return `Invalid calendar date: ${key}.${field}`;
      }
      if (r.observedAt != null && !isObservationDate(r.observedAt))
        return `Invalid observation date in ${key}`;
      if (
        r.sourceWindowStart &&
        r.sourceWindowEnd &&
        r.sourceWindowStart > r.sourceWindowEnd
      )
        return 'Source window ends before it starts';
      if (key === 'sources' && (!nonempty(r.name) || !isHttpsUrl(r.url)))
        return 'Sources require a valid HTTPS URL and name';
      if (key === 'series') {
        if (
          !nonempty(r.sourceId) ||
          !nonempty(r.provider) ||
          !nonempty(r.model) ||
          !Array.isArray(r.points)
        )
          return 'Invalid series metadata';
        if (r.apiUrl != null && !isHttpsUrl(r.apiUrl))
          return 'Series API URL must use HTTPS';
        const dates = new Set<string>();
        for (const p of r.points) {
          if (
            !p ||
            !isCalendarDate(p.date) ||
            !Number.isFinite(p.value) ||
            p.value <= 0 ||
            dates.has(p.date)
          )
            return 'Invalid or duplicate index point';
          dates.add(p.date);
        }
      }
      if (key === 'history') {
        if (
          !nonempty(r.sourceId) ||
          !nonempty(r.label) ||
          !nonempty(r.unit) ||
          !nonempty(r.metric) ||
          !['daily', 'weekly'].includes(r.frequency) ||
          !['observation', 'effective_price'].includes(r.method) ||
          !Array.isArray(r.points)
        )
          return 'Invalid history metadata';
        const dates = new Set<string>();
        for (const p of r.points) {
          if (
            !p ||
            !isCalendarDate(p.date) ||
            (p.value !== null && !Number.isFinite(p.value)) ||
            dates.has(p.date)
          )
            return 'Invalid or duplicate historical observation';
          if (p.periodStart != null && !isCalendarDate(p.periodStart))
            return 'Invalid history period start';
          if (p.periodEnd != null && !isCalendarDate(p.periodEnd))
            return 'Invalid history period end';
          dates.add(p.date);
        }
      }
      if (
        key === 'quotes' &&
        (!nonempty(r.sourceId) ||
          !Number.isFinite(r.usdPerHour) ||
          r.usdPerHour <= 0 ||
          !isObservationDate(r.observedAt))
      )
        return 'Quote requires positive price, source and valid observation date';
      if (key === 'deals') {
        if (
          !nonempty(r.sourceId) ||
          !nonempty(r.company) ||
          !Number.isFinite(r.amountUsdM) ||
          r.amountUsdM <= 0
        )
          return 'Deal requires amount, company and source';
        if (
          r.includeInNewEquity !== undefined &&
          typeof r.includeInNewEquity !== 'boolean'
        )
          return 'includeInNewEquity must be a boolean';
        if (
          r.dateBasis === 'announcement' &&
          !isCalendarDate(r.announcementDate)
        )
          return 'Announcement-based deal requires announcementDate';
        if (
          r.dateBasis === 'source_window' &&
          (!isCalendarDate(r.sourceWindowStart) ||
            !isCalendarDate(r.sourceWindowEnd))
        )
          return 'Source-window deal requires start and end dates';
        if (r.dateBasis === 'cash_received' && !isCalendarDate(r.cashDate))
          return 'Cash-received deal requires cashDate';
      }
      if (
        key === 'events' &&
        (!isCalendarDate(r.date) || !nonempty(r.sourceId))
      )
        return 'Event requires date and source';
      if (key === 'bonds' && r.quote != null) {
        const q = r.quote;
        if (
          typeof q !== 'object' ||
          Array.isArray(q) ||
          !isCalendarDate(q.date) ||
          !isCalendarDate(q.treasuryDate) ||
          !nonempty(q.sourceId) ||
          !nonempty(q.treasurySourceId) ||
          ![q.ytmPct, q.treasuryPct].every(Number.isFinite) ||
          !Number.isFinite(q.cleanPrice) ||
          q.cleanPrice <= 0
        )
          return 'Bond quote requires positive cleanPrice, finite yields, trade and Treasury dates, and both sources';
        if (q.date !== q.treasuryDate)
          return 'Bond quote and Treasury curve must have the same date';
        const calculated = (q.ytmPct - q.treasuryPct) * 100;
        if (
          !Number.isFinite(calculated) ||
          !Number.isFinite(q.spreadBp) ||
          Math.abs(calculated - q.spreadBp) > 0.1
        )
          return 'Spread must equal (ytmPct - treasuryPct) * 100';
      }
    }
  }
  if (patch.schedule !== undefined) {
    const s = patch.schedule;
    if (
      !s ||
      typeof s !== 'object' ||
      Array.isArray(s) ||
      typeof s.time !== 'string' ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.time) ||
      s.timezone !== 'Asia/Taipei' ||
      typeof s.enabled !== 'boolean'
    )
      return 'Invalid schedule';
  }
  return null;
}
