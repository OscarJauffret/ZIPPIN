// All timetable data is Swiss-local. The app may be opened from any timezone,
// so every human-facing time is formatted in Europe/Zurich explicitly rather
// than relying on the viewer's clock.

const ZURICH = 'Europe/Zurich';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZURICH,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23',
});

/** Break a unix timestamp (seconds) into Zurich-local calendar parts. */
export function zurichParts(ts) {
  const out = {};
  for (const p of partsFmt.formatToParts(new Date(ts * 1000))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

/** "HH:MM" in Zurich local time. */
export function fmtTime(ts) {
  const p = zurichParts(ts);
  return `${p.hour}:${p.minute}`;
}

/** "YYYY-MM-DD" — the format the opendata.ch API expects. */
export function apiDate(ts) {
  const p = zurichParts(ts);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "DD.MM.YYYY" — the format sbb.ch deep links expect. */
export function swissDate(ts) {
  const p = zurichParts(ts);
  return `${p.day}.${p.month}.${p.year}`;
}

/** Minutes since Zurich-local midnight. DST-safe because it goes through Intl. */
export function minutesOfDay(ts) {
  const p = zurichParts(ts);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** Seconds → "2h 36" / "47 min". */
export function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}`;
}

/** Seconds → "+4 min" / "−3 min", for deltas. */
export function fmtDelta(sec) {
  const m = Math.round(Math.abs(sec) / 60);
  return `${sec < 0 ? '−' : '+'}${m} min`;
}

/** "HH:MM" string → minutes since midnight. Returns null if unparseable. */
export function parseClock(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((str || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Inverse of the formatters: a Zurich-local "YYYY-MM-DD" + "HH:MM" → unix seconds.
 * Solved by iteration rather than a hardcoded offset, so it stays right across
 * DST boundaries. Two passes are enough to converge.
 */
export function tsFromZurich(dateStr, timeStr) {
  const [y, m, d] = (dateStr || '').split('-').map(Number);
  const [hh, mm] = (timeStr || '').split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;

  const wanted = Date.UTC(y, m - 1, d, hh, mm) / 1000;
  let ts = wanted;
  for (let i = 0; i < 2; i++) {
    const p = zurichParts(ts);
    const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 1000;
    ts += wanted - seen;
  }
  return ts;
}

/** Today's date in Zurich, as YYYY-MM-DD — used to seed the date input. */
export function todayInZurich() {
  return apiDate(Math.floor(Date.now() / 1000));
}

/** Current Zurich wall-clock as HH:MM — used to seed the time input. */
export function nowInZurich() {
  return fmtTime(Math.floor(Date.now() / 1000));
}
