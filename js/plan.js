// The two features that make this more than a timetable mirror.

import { connections, connectionsArrivingBy, finalize } from './api.js';
import { apiDate, fmtTime, minutesOfDay, swissDate } from './time.js';

// ---------------------------------------------------------------------------
// 1. Speedy mode
// ---------------------------------------------------------------------------
//
// The plan was to pass a walking-speed / minimum-transfer-time parameter to the
// journey planner. Neither keyless Swiss API honours one — transport.opendata.ch
// and search.ch both return byte-identical results with those parameters set, so
// they are silently ignored (verified against several routes).
//
// So the effect is reconstructed client side. The padding that hides tight
// connections is applied to *through* searches. A fresh search anchored at an
// intermediate station has no transfer to pad, so it will happily offer a train
// leaving two minutes from now. Speedy mode exploits exactly that, in whichever
// direction the traveller actually cares about:
//
//   depart-at  → keep the departure, re-search onward from each change,
//                arrive earlier.
//   arrive-by  → keep the arrival, re-search the run-up to each change with
//                isArrivalTime, leave later.
//
// The "hurry factor" is a floor on the real gap between arriving and the onward
// train leaving, not an opaque speed multiplier — so the user can judge it.

const MAX_SUBQUERIES = 24; // keeps a single search well inside the public rate limit

/** Leg-array index of the n-th ride leg. */
function rideLegIndex(journey, n) {
  let seen = 0;
  for (let i = 0; i < journey.legs.length; i++) {
    if (journey.legs[i].type !== 'ride') continue;
    if (seen === n) return i;
    seen++;
  }
  return -1;
}

/**
 * Copy a leg list, tagging one leg with the transfer time the standard search
 * allowed before this leg. Tagging a clone keeps the original journey — which is
 * still on screen — untouched. An existing tag wins, so recursive tightening
 * still reports the *original* official figure rather than the last one.
 */
function tagOnward(legs, onwardLeg, officialGapSec) {
  return legs.map((l) => (l === onwardLeg
    ? { ...l, officialGapSec: l.officialGapSec ?? officialGapSec }
    : l));
}

/** `base` up to and including ride `i`, continued by journey `alt`. */
function spliceAfter(base, i, alt, officialGapSec) {
  const cut = rideLegIndex(base, i);
  const legs = [
    ...base.legs.slice(0, cut + 1),
    ...tagOnward(alt.legs, alt.rides[0], officialGapSec),
  ];
  const j = finalize({
    from: base.from, to: alt.to,
    depTs: base.depTs, arrTs: alt.arrTs,
    depPlatform: base.depPlatform, arrPlatform: alt.arrPlatform,
    legs, speedy: true,
  });
  // If the sprint fails you are simply back on the journey the standard search
  // would have given you — worth stating outright, since it makes the gamble free.
  const orig = base.rides[i + 1];
  j.fallback = {
    kind: 'onward',
    station: base.rides[i].to,
    line: orig.line,
    depTs: orig.depTs,
    platform: orig.depPlatform,
    arrTs: base.arrTs,
  };
  return j;
}

/** Journey `alt` (origin → change station), continued by `base` after ride `i`. */
function spliceBefore(base, i, alt, officialGapSec) {
  const cut = rideLegIndex(base, i);
  const legs = [
    ...alt.legs,
    ...tagOnward(base.legs.slice(cut + 1), base.rides[i + 1], officialGapSec),
  ];
  const j = finalize({
    from: alt.from, to: base.to,
    depTs: alt.depTs, arrTs: base.arrTs,
    depPlatform: alt.depPlatform, arrPlatform: base.arrPlatform,
    legs, speedy: true,
  });
  // Here the gamble is not free: leaving later means missing the change costs you
  // the arrival time you asked for. The safe move is the earlier start.
  j.fallback = {
    kind: 'earlier-start',
    station: base.from,
    depTs: base.depTs,
    arrTs: base.arrTs,
  };
  return j;
}

/**
 * Find connections a quick walker could catch that the default search omits.
 *
 * @param {object}   o
 * @param {object}   o.origin       {id, name} of A
 * @param {object}   o.destination  {id, name} of Z
 * @param {object[]} o.baseJourneys standard results to improve on
 * @param {number}   o.minGapSec    smallest change the user will accept
 * @param {boolean}  o.arriveBy     true when the search was "arrive by"
 * @param {object}   o.query        via / transportations to keep sub-queries consistent
 * @param {number}   o.depth        how many changes deep to keep re-splicing
 * @param {function} o.onFound      called with each new journey as it is found
 * @returns {Promise<object[]>} speedy journeys, best first
 */
export async function findSpeedy({
  origin, destination, baseJourneys, minGapSec,
  arriveBy = false, query = {}, depth = 2, onFound,
}) {
  const found = new Map();
  const seen = new Set(baseJourneys.map((j) => j.key));
  let budget = MAX_SUBQUERIES;

  const from = origin.id || origin.name;
  const dest = destination.id || destination.name;

  // `root` is the standard result this branch started from. Gains are measured
  // against that, not against the best standard result overall — a speedy variant
  // of the 09:00 departure should be compared with the 09:00 departure.
  async function improve(journey, level, root) {
    if (level > depth) return;

    for (let i = 0; i < journey.rides.length - 1; i++) {
      if (budget <= 0) return;

      const ride = journey.rides[i];
      const onward = journey.rides[i + 1];
      const origGap = onward.depTs - ride.arrTs;

      // Already at or below the floor — no tighter option is worth offering.
      if (origGap <= minGapSec) continue;

      const station = ride.to;
      budget -= arriveBy ? 2 : 1; // the arrive-by helper may issue a second call

      let alts;
      try {
        alts = arriveBy
          // Latest we may reach the change station and still make this train.
          // The base journey already tells us how long origin → station takes,
          // which saves the helper a probe query.
          ? await connectionsArrivingBy({
            from, to: station.id || station.name,
            deadlineTs: onward.depTs - minGapSec,
            estDurationSec: ride.arrTs - journey.depTs,
            limit: 4, ...query,
          })
          : await connections({
            from: station.id || station.name, to: dest,
            date: apiDate(ride.arrTs),
            time: fmtTime(ride.arrTs),
            limit: 4, ...query,
          });
      } catch {
        continue; // one dead sub-query shouldn't kill the whole search
      }

      for (const alt of alts) {
        let candidate;

        if (arriveBy) {
          const gap = onward.depTs - alt.arrTs;
          if (gap < minGapSec) continue;        // uncatchable even at a sprint
          if (gap >= origGap) continue;         // not tighter than what we have
          if (alt.depTs <= journey.depTs) continue; // tighter but no later start
          candidate = spliceBefore(journey, i, alt, origGap);
        } else {
          const gap = alt.depTs - ride.arrTs;
          if (gap < minGapSec) continue;
          if (gap >= origGap) continue;
          if (alt.arrTs >= journey.arrTs) continue; // tighter but no earlier finish
          candidate = spliceAfter(journey, i, alt, origGap);
        }

        if (seen.has(candidate.key)) continue;
        seen.add(candidate.key);

        candidate.gainKind = arriveBy ? 'later' : 'earlier';
        candidate.gainSec = arriveBy
          ? candidate.depTs - root.depTs   // leave this much later
          : root.arrTs - candidate.arrTs;  // arrive this much earlier
        found.set(candidate.key, candidate);
        onFound?.(candidate);

        await improve(candidate, level + 1, root);
      }
    }
  }

  for (const j of baseJourneys) {
    if (budget <= 0) break;
    await improve(j, 1, j);
  }

  return [...found.values()].sort((a, b) => (arriveBy
    ? b.depTs - a.depTs || b.minGapSec - a.minGapSec   // latest departure first
    : a.arrTs - b.arrTs || b.minGapSec - a.minGapSec)); // earliest arrival first
}

// ---------------------------------------------------------------------------
// 2. Night-GA / partial-ticket helper
// ---------------------------------------------------------------------------

/** Is a Zurich-local minute-of-day inside the night window? Handles wraparound. */
function inWindow(m, start, end) {
  return start <= end ? (m >= start && m < end) : (m >= start || m < end);
}

/** Ordered stop sequence across every ride leg, with the leg each stop belongs to. */
function stopSequence(journey) {
  const out = [];
  for (const ride of journey.rides) {
    const stops = ride.passList.length
      ? ride.passList
      : [
          { ...ride.from, depTs: ride.depTs, arrTs: null },
          { ...ride.to, depTs: null, arrTs: ride.arrTs },
        ];
    for (const s of stops) out.push({ ...s, ride });
  }
  return out;
}

/**
 * Find the station where the ticket can stop: the first stop the train departs
 * once the night window has opened. Everything from there on is covered by the
 * Night GA, so only A → that station needs buying.
 *
 * @returns {{status: string, ...}} status is one of:
 *   'covered'  — the journey is already inside the window at departure
 *   'outside'  — no part of the journey falls in the window
 *   'split'    — buy from origin to `station`
 */
export function nightSplit(journey, windowStartMin, windowEndMin) {
  const stops = stopSequence(journey);
  const departures = stops.filter((s) => s.depTs != null);
  if (!departures.length) return { status: 'outside' };

  const hit = departures.find((s) => inWindow(minutesOfDay(s.depTs), windowStartMin, windowEndMin));
  if (!hit) return { status: 'outside' };

  // The very first departure is already in the window — nothing to buy.
  if (hit.depTs === departures[0].depTs && hit.name === departures[0].name) {
    return { status: 'covered', from: journey.from, depTs: journey.depTs };
  }

  // Coordinates ride along: rankNightSplits uses distance as its fare proxy.
  const station = { id: hit.id, name: hit.name, lat: hit.lat, lon: hit.lon };
  return {
    status: 'split',
    station,
    depTs: hit.depTs,
    ride: hit.ride,
    buy: { from: journey.from, to: station },
  };
}

/** Great-circle km between two stations, or null if either lacks coordinates. */
function distanceKm(a, b) {
  if (a?.lat == null || b?.lat == null) return null;
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Track kilometres from the origin to the split, summed stop to stop.
 *
 * Straight-line origin→split distance is a bad proxy for a rail fare: two split
 * stations can sit the same distance from the origin as the crow flies while the
 * routes to them differ substantially. Following the actual stop sequence tracks
 * what you'd be charged for far more closely.
 */
function paidRouteKm(journey, splitDepTs) {
  const stops = stopSequence(journey);
  let km = 0;
  let prev = null;
  for (const s of stops) {
    if (prev) {
      const d = distanceKm(prev, s);
      if (d == null) return null; // a gap in the data makes the total meaningless
      km += d;
    }
    prev = s;
    if (s.depTs === splitDepTs) return km;
  }
  return null;
}

/**
 * Compare the Night-GA split across a whole result set and mark the best one.
 *
 * A connection that leaves later can cross into the night window far earlier in
 * its route, leaving a much shorter stretch to pay for. Swiss fares are broadly
 * distance-based, so distance from the origin to the split station is used as
 * the ranking proxy — never as a price, which ZIPPIN does not claim to know.
 *
 * Mutates each journey with `.night`, and returns the distinct split options
 * ranked shortest-first. The caller shows more than one: distance is a proxy, not
 * a price, so the runner-up may well be the cheaper ticket.
 */
export function rankNightSplits(journeys, startMin, endMin) {
  let best = null;
  const options = new Map(); // split station name -> option

  for (const j of journeys) {
    const split = nightSplit(j, startMin, endMin);
    j.night = split;

    // Journeys already wholly inside the window need no ticket at all, and say
    // so plainly. Only the ones that cost something are worth ranking.
    if (split.status !== 'split') continue;

    split.paidKm = paidRouteKm(j, split.depTs) ?? distanceKm(j.from, split.station);
    split.paidSec = split.depTs - j.depTs;

    // Prefer the shortest paid stretch; fall back to paid time where a station
    // is missing coordinates so the comparison stays meaningful.
    const score = split.paidKm ?? (split.paidSec / 60);
    if (best == null || score < best.score) best = { journey: j, split, score };

    // One entry per split station: several departures can share a split point,
    // and only the earliest of them is worth offering.
    const prev = options.get(split.station.name);
    if (!prev || j.depTs < prev.journey.depTs) {
      options.set(split.station.name, { journey: j, split, score });
    }
  }

  if (best) best.split.isBest = true;
  return {
    best,
    options: [...options.values()].sort((a, b) => a.score - b.score),
  };
}

/** Deep link into SBB's own timetable, prefilled, so the real price is shown there. */
export function sbbLink(from, to, ts) {
  const q = new URLSearchParams({
    von: from.name,
    nach: to.name,
    datum: swissDate(ts),
    zeit: fmtTime(ts),
  });
  return `https://www.sbb.ch/en/buying/pages/fahrplan/fahrplan.xhtml?${q}`;
}
