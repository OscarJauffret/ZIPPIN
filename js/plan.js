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

/**
 * Above this, a change is a wait, not a hurry.
 *
 * The splice only requires the new gap to beat the old one, which says nothing
 * about whether hurrying is involved: shortening a 160-minute layover at
 * Annemasse to 100 minutes is a real improvement and a genuinely faster journey,
 * but dressing it up as "you'll do it in 100 😎" is nonsense. Results are
 * therefore classified, not filtered — anything above this ceiling is presented
 * as a longer chain of connections, which is what it actually is.
 */
export const TIGHT_GAP_SEC = 12 * 60;

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

  /**
   * The gain a traveller actually experiences: how much this beats the best
   * standard result they could still choose instead.
   *
   * Measuring against the branch's own root overstates it. A variant of the
   * 08:28 arrival can land at 05:28 and be called "180 min earlier" while a
   * standard result already arrives 05:28 — two cards, identical times, one
   * claiming a three-hour saving. Comparing against every standard option not
   * already ruled out by the clock avoids that.
   */
  function realGain(candidate, root) {
    if (arriveBy) {
      // Only starts that still meet the deadline compete.
      const rivals = baseJourneys.filter((b) => b.arrTs <= candidate.arrTs);
      const latest = rivals.length ? Math.max(...rivals.map((b) => b.depTs)) : root.depTs;
      return candidate.depTs - latest;
    }
    // Leaving earlier than the candidate isn't an option, so those don't compete.
    const rivals = baseJourneys.filter((b) => b.depTs >= candidate.depTs);
    const earliest = rivals.length ? Math.min(...rivals.map((b) => b.arrTs)) : root.arrTs;
    return earliest - candidate.arrTs;
  }

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

        // Beating the journey it was spliced from isn't enough — it has to beat
        // everything the standard search already offered, or it is not a find.
        const gainSec = realGain(candidate, root);
        if (gainSec <= 0) {
          // Still worth recursing: a deeper splice off this one may yet win.
          await improve(candidate, level + 1, root);
          continue;
        }

        // What did this actually cost the traveller? A tightened change asks them
        // to hurry; extra changes ask them to sit through more connections. The
        // two are independent, and a result can involve both or neither.
        candidate.tightChanges = candidate.changes.filter(
          (c) => c.officialGapSec != null && c.gapSec <= TIGHT_GAP_SEC,
        );
        candidate.isHurried = candidate.tightChanges.length > 0;
        candidate.extraChanges = candidate.transfers - root.transfers;

        candidate.gainKind = arriveBy ? 'later' : 'earlier';
        candidate.gainSec = gainSec;
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
//
// A Night GA covers travel that is BOTH inside Switzerland and inside the night
// window. Neither condition alone is enough, and an earlier version checked only
// the second — which declared a Montpellier→Paris→Zürich journey "fully covered"
// because it happened to leave at 19:50.
//
// So coverage is worked out per stop-to-stop segment, then contiguous runs are
// merged. Merging deliberately crosses train changes: if you ride A→F→M→Z and
// only H→L is covered, that is two tickets (A→H and L→Z), not four. Changing
// trains inside a paid stretch costs nothing extra and buying fewer, longer
// tickets is more robust if a train is cancelled.

/** Swiss stations are UIC 85xxxxx. France is 87, Germany 80, Italy 83, Austria 81. */
function isSwiss(station) {
  return /^85/.test(String(station?.id ?? ''));
}

/** Is a Zurich-local minute-of-day inside the night window? Handles wraparound. */
function inWindow(m, start, end) {
  return start <= end ? (m >= start && m < end) : (m >= start || m < end);
}

/**
 * Real stations carry a UIC-style id: 8 followed by six digits (85… Swiss,
 * 87… French, and so on). Stop lists also contain operational waypoints such as
 * "Bahn-2000-Strecke" (id 0000132) — stretches of track, not places, and
 * certainly not somewhere you can buy a ticket to.
 */
function isTicketableStop(s) {
  return /^8\d{6}$/.test(String(s?.id ?? ''));
}

/** Ordered stop sequence across every ride leg, with the leg each stop belongs to. */
function stopSequence(journey) {
  const out = [];
  for (const ride of journey.rides) {
    const raw = ride.passList.length
      ? ride.passList
      : [
          { ...ride.from, depTs: ride.depTs, arrTs: null },
          { ...ride.to, depTs: null, arrTs: ride.arrTs },
        ];
    // Left in, a waypoint reads as "not Swiss" and splits a covered stretch at a
    // boundary that doesn't exist — which is how Solothurn → Olten, entirely
    // inside Switzerland, came out as a stretch needing a ticket.
    const clean = raw.filter(isTicketableStop);
    for (const s of (clean.length >= 2 ? clean : raw)) out.push({ ...s, ride });
  }
  return out;
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
 * Split a journey into consecutive stretches, each either covered by the Night
 * GA or needing a ticket.
 *
 * @returns {{status: string, stretches: object[], paid: object[], paidKm: number|null,
 *            freeSec: number, planKey: string}}
 *   status is 'all-free' (buy nothing), 'all-paid' (the pass never applies) or
 *   'partial' (buy the paid stretches only).
 */
export function nightCoverage(journey, startMin, endMin) {
  const stops = stopSequence(journey);

  // Movement between two different stations. Consecutive stops sharing a name are
  // the two halves of a change, which is dwell time, not travel.
  const segments = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (a.name === b.name) continue;
    const depTs = a.depTs ?? b.arrTs;
    if (depTs == null) continue;

    const swiss = isSwiss(a) && isSwiss(b);
    const night = inWindow(minutesOfDay(depTs), startMin, endMin);
    segments.push({
      from: a,
      to: b,
      depTs,
      arrTs: b.arrTs ?? b.depTs ?? depTs,
      km: distanceKm(a, b),
      covered: swiss && night,
      swiss,
      night,
    });
  }

  if (!segments.length) {
    return { status: 'all-paid', stretches: [], paid: [], paidKm: null, freeSec: 0, planKey: 'none' };
  }

  // Merge neighbouring segments that agree, so a paid stretch spans as many
  // trains as it needs to and becomes a single ticket.
  const stretches = [];
  for (const seg of segments) {
    const last = stretches[stretches.length - 1];
    if (last && last.covered === seg.covered) {
      last.to = seg.to;
      last.arrTs = seg.arrTs;
      last.km = last.km == null || seg.km == null ? null : last.km + seg.km;
      last.anyNonSwiss = last.anyNonSwiss || !seg.swiss;
      last.anyOutsideWindow = last.anyOutsideWindow || !seg.night;
    } else {
      stretches.push({
        covered: seg.covered,
        from: seg.from,
        to: seg.to,
        depTs: seg.depTs,
        arrTs: seg.arrTs,
        km: seg.km,
        anyNonSwiss: !seg.swiss,
        anyOutsideWindow: !seg.night,
      });
    }
  }

  const paid = stretches.filter((s) => !s.covered);
  const free = stretches.filter((s) => s.covered);
  const paidKm = paid.every((s) => s.km != null)
    ? paid.reduce((t, s) => t + s.km, 0)
    : null;

  const status = !paid.length ? 'all-free' : (!free.length ? 'all-paid' : 'partial');

  return {
    status,
    stretches,
    paid,
    paidKm,
    paidSec: paid.reduce((t, s) => t + (s.arrTs - s.depTs), 0),
    freeSec: free.reduce((t, s) => t + (s.arrTs - s.depTs), 0),
    // Two departures that need the same tickets are the same plan to a buyer.
    planKey: paid.map((s) => `${s.from.name}>${s.to.name}`).join('|') || 'free',
  };
}

/**
 * Work out the Night-GA plan for every result and collect the distinct ones.
 *
 * A later departure can cross into the window earlier in its route and leave far
 * less to pay for. Swiss fares are broadly distance-based, so total paid km ranks
 * the plans — as a proxy, never as a price, which ZIPPIN does not claim to know.
 *
 * Mutates each journey with `.night` and returns the distinct plans, cheapest
 * proxy first. Every plan is offered, not just the winner: the ranking is an
 * estimate, so the runner-up may be the better buy.
 */
export function rankNightPlans(journeys, startMin, endMin) {
  const options = new Map(); // planKey -> option

  for (const j of journeys) {
    const plan = nightCoverage(j, startMin, endMin);
    j.night = plan;
    if (plan.status === 'all-paid') continue; // the pass buys nothing here

    const score = plan.paidKm ?? plan.paidSec / 60;
    const prev = options.get(plan.planKey);
    if (prev) {
      // Same tickets, different departure. Keep the earliest as the example but
      // remember them all, so the summary can account for every badged result.
      prev.journeys.push(j);
      if (j.depTs < prev.journey.depTs) { prev.journey = j; prev.plan = plan; }
    } else {
      options.set(plan.planKey, { journey: j, journeys: [j], plan, score });
    }
  }

  const ranked = [...options.values()].sort((a, b) => a.score - b.score);
  for (const o of ranked) o.journeys.sort((a, b) => a.depTs - b.depTs);
  if (ranked.length) ranked[0].plan.isBest = true;
  return {
    best: ranked[0] || null,
    options: ranked,
    // How many results carry a night badge — the summary heading counts plans,
    // and the two numbers differ whenever departures share a ticket plan.
    badged: ranked.reduce((n, o) => n + o.journeys.length, 0),
  };
}

/**
 * Deep link into SBB's own timetable, prefilled, so the real price is shown there.
 *
 * SBB has no URL for an individual connection: expanding one on their site does
 * not change the address, because the connection is held client side behind a
 * backend token we cannot construct. The closest achievable is to anchor the
 * search on the exact departure minute, which puts the intended trip first in
 * the list — so callers should also show its times, letting the traveller
 * recognise the row on arrival.
 *
 * Only the four parameters verified to work are sent. Extra ones are a real
 * risk: a link that silently lands on an empty search is worse than one that
 * lands on a list.
 */
export function sbbLink(from, to, ts) {
  const q = new URLSearchParams({
    von: from.name,
    nach: to.name,
    datum: swissDate(ts),
    zeit: fmtTime(ts),
  });
  return `https://www.sbb.ch/en/buying/pages/fahrplan/fahrplan.xhtml?${q}`;
}
