// Thin client for transport.opendata.ch (free, no API key, CORS-open).
//
// The public endpoint is rate limited per IP, and Speedy mode fans out into
// several extra queries per search, so every response is cached for the
// lifetime of the page and identical in-flight requests are shared.

import { apiDate, fmtTime } from './time.js';

const BASE = 'https://transport.opendata.ch/v1';
const MAX_CONCURRENT = 4;

const cache = new Map();     // url -> parsed JSON
const inflight = new Map();  // url -> Promise

let active = 0;
const queue = [];

/** Requests actually sent to the network this session (cache hits excluded). */
export const stats = { requests: 0, cached: 0 };

function schedule(run) {
  return new Promise((resolve, reject) => {
    queue.push(() => run().then(resolve, reject));
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    job().finally(() => { active--; pump(); });
  }
}

async function get(path, params) {
  const url = `${BASE}${path}?${params}`;
  if (cache.has(url)) { stats.cached++; return cache.get(url); }
  if (inflight.has(url)) return inflight.get(url);

  const p = schedule(async () => {
    stats.requests++;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429) throw new ApiError('Rate limited by transport.opendata.ch. Wait a minute and try again.', 429);
    if (!res.ok) throw new ApiError(`Timetable service returned ${res.status}.`, res.status);
    const json = await res.json();
    cache.set(url, json);
    return json;
  }).finally(() => inflight.delete(url));

  inflight.set(url, p);
  return p;
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Station autocomplete. Returns [{id, name}]. */
export async function searchStations(query) {
  if (!query || query.trim().length < 2) return [];
  const json = await get('/locations', new URLSearchParams({ query: query.trim(), type: 'station' }));
  return (json.stations || [])
    .filter((s) => s.id && s.name)
    .map((s) => ({ id: s.id, name: s.name }));
}

/**
 * Journey search. `from`/`to` accept either a station id or a name; ids are
 * preferred because they are unambiguous.
 *
 * Only parameters the endpoint actually honours are sent. `direct`, `bike` and
 * `accessibility` are accepted by the URL but silently ignored by the service
 * (verified: a `direct=1` search on a route with no direct service still
 * returns two-transfer results), so "direct only" is filtered client side in
 * app.js rather than pretended at here.
 */
export async function connections({
  from, to, date, time, limit = 6,
  isArrivalTime = false, via = null, transportations = null,
}) {
  const params = new URLSearchParams({ from, to, date, time, limit: String(limit) });
  if (isArrivalTime) params.set('isArrivalTime', '1');
  if (via) params.set('via', via);
  for (const t of transportations || []) params.append('transportations[]', t);

  const json = await get('/connections', params);
  return (json.connections || []).map(normalize).filter(Boolean);
}

/**
 * "Arrive by" done properly.
 *
 * The endpoint's own `isArrivalTime` is close to useless: it returns a window
 * that ends well before the requested time, and raising `limit` extends that
 * window *backwards*. Asking for "arrive at Zürich by 10:30" yields nothing
 * later than 09:30 no matter the limit — never the trains you'd actually take.
 *
 * So we search forwards from an estimated start instead and keep what lands in
 * time. Pass `estDurationSec` when a comparable journey time is already known,
 * to skip the probe query.
 */
export async function connectionsArrivingBy({
  from, to, deadlineTs, limit = 6, estDurationSec = null, ...query
}) {
  let duration = estDurationSec;
  if (duration == null) {
    const probe = await connections({
      from, to, date: apiDate(deadlineTs), time: fmtTime(deadlineTs), limit: 1, ...query,
    });
    duration = probe.length ? probe[0].durationSec : 3600;
  }

  // Start early enough that the first results land before the deadline, then
  // widen once if the duration estimate was optimistic.
  for (const slack of [30 * 60, 120 * 60]) {
    const startTs = deadlineTs - duration - slack;
    const res = await connections({
      from, to,
      date: apiDate(startTs), time: fmtTime(startTs),
      limit: Math.min(16, limit * 2 + 2),
      ...query,
    });
    const inTime = res.filter((j) => j.arrTs <= deadlineTs);
    if (inTime.length) return inTime.slice(-limit); // the latest possible starts
  }
  return [];
}

// --- normalization -------------------------------------------------------
//
// The raw API shape is deeply nested and inconsistent (walk sections have no
// `journey`, some fields are null). Everything downstream works on this
// flattened form instead.

function stationOf(node) {
  const s = node?.station || node?.location || {};
  const c = s.coordinate;
  return {
    id: s.id || null,
    name: s.name || '—',
    // Kept for the Night-GA helper, which uses distance as a fare proxy.
    lat: typeof c?.x === 'number' ? c.x : null,
    lon: typeof c?.y === 'number' ? c.y : null,
  };
}

function normalizeStop(stop) {
  return {
    ...stationOf(stop),
    arrTs: stop.arrivalTimestamp ?? null,
    depTs: stop.departureTimestamp ?? null,
    platform: stop.platform || null,
  };
}

/** Raw API connection → flat journey object, or null if unusable. */
export function normalize(conn) {
  if (!conn?.from || !conn?.to || !conn.sections) return null;

  const legs = [];
  for (const s of conn.sections) {
    const from = stationOf(s.departure);
    const to = stationOf(s.arrival);
    const depTs = s.departure?.departureTimestamp ?? null;
    const arrTs = s.arrival?.arrivalTimestamp ?? null;

    if (s.journey) {
      const j = s.journey;
      // Train numbers arrive zero-padded on some services ("000153" → "153").
      const num = String(j.number ?? '').replace(/^0+(?=\d)/, '');
      legs.push({
        type: 'ride',
        from, to, depTs, arrTs,
        line: `${j.category || ''}${num ? ' ' + num : ''}`.trim() || (j.name || '?'),
        category: j.category || '',
        operator: j.operator || '',
        headsign: j.to || '',
        depPlatform: s.departure?.platform || null,
        arrPlatform: s.arrival?.platform || null,
        passList: (j.passList || []).map(normalizeStop),
      });
    } else {
      // Walking transfer between two stations (or within a stop).
      legs.push({
        type: 'walk',
        from, to, depTs, arrTs,
        duration: s.walk?.duration ?? null,
      });
    }
  }

  const rides = legs.filter((l) => l.type === 'ride');
  if (!rides.length) return null;

  const depTs = conn.from.departureTimestamp ?? rides[0].depTs;
  const arrTs = conn.to.arrivalTimestamp ?? rides[rides.length - 1].arrTs;
  if (depTs == null || arrTs == null) return null;

  return finalize({
    from: stationOf(conn.from),
    to: stationOf(conn.to),
    depTs,
    arrTs,
    depPlatform: conn.from.platform || null,
    arrPlatform: conn.to.platform || null,
    legs,
    speedy: false,
    savedSec: 0,
  });
}

/**
 * How realistic is a given change? Used to label aggressive results honestly
 * rather than presenting a zero-minute transfer as if it were catchable.
 */
function feasibilityOf(gapSec, walk, arrPlatform, depPlatform) {
  const min = gapSec / 60;
  const samePlatform = arrPlatform && depPlatform && arrPlatform === depPlatform;
  if (min >= 5) return 'comfortable';
  if (min >= 2) return 'tight';
  if (min >= 1) return walk ? 'implausible' : 'very-tight';
  // Zero minutes: the onward train leaves the same minute you arrive.
  if (walk) return 'impossible';
  return samePlatform ? 'improbable' : 'implausible';
}

/**
 * Recompute the fields that depend on the leg list. Called on every journey,
 * including ones Speedy mode assembles by splicing legs from two searches.
 */
export function finalize(j) {
  const rides = j.legs.filter((l) => l.type === 'ride');
  j.rides = rides;
  j.transfers = Math.max(0, rides.length - 1);
  j.products = rides.map((r) => r.line);
  j.durationSec = j.arrTs - j.depTs;

  // Time available at each change, measured from arrival to onward departure.
  // Any walking between platforms or stations happens inside this window, so
  // this is the number the traveller actually has to work with.
  j.changes = [];
  for (let i = 0; i < rides.length - 1; i++) {
    const gapSec = rides[i + 1].depTs - rides[i].arrTs;
    const arrPlatform = rides[i].arrPlatform;
    const depPlatform = rides[i + 1].depPlatform;
    // A change that also moves between two differently-named stations
    // implies a street walk, not just a platform hop.
    const walk = rides[i].to.name !== rides[i + 1].from.name;
    j.changes.push({
      station: rides[i].to,
      arrTs: rides[i].arrTs,
      depTs: rides[i + 1].depTs,
      gapSec,
      arrPlatform,
      depPlatform,
      walk,
      // What the standard search allowed for this same change, when Speedy mode
      // tightened it. Lives on the onward leg so it survives splicing.
      officialGapSec: rides[i + 1].officialGapSec ?? null,
      feasibility: feasibilityOf(gapSec, walk, arrPlatform, depPlatform),
    });
  }
  j.minGapSec = j.changes.length ? Math.min(...j.changes.map((c) => c.gapSec)) : Infinity;

  // Stable identity so equivalent journeys from different searches dedupe.
  j.key = [j.depTs, j.arrTs, ...rides.map((r) => `${r.line}@${r.depTs}`)].join('|');
  return j;
}
