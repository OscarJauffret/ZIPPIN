import {
  ApiError, connections, connectionsArrivingBy, searchStations, stats,
} from './api.js';
import { findSpeedy, rankNightSplits, sbbLink } from './plan.js';
import {
  apiDate, fmtDuration, fmtTime, nowInZurich, parseClock, todayInZurich, tsFromZurich,
} from './time.js';

// How far before the stated departure time to look for trains you could still
// catch if you were already on the platform.
const HEAD_START_MIN = 5;

// Slider position → how tight a change the user is willing to accept.
const HURRY = [
  { label: 'Normal — official timings', gapMin: null },
  { label: 'Quick — 4 min changes',     gapMin: 4 },
  { label: 'Brisk — 3 min changes',     gapMin: 3 },
  { label: 'Sprint — 2 min changes',    gapMin: 2 },
  { label: 'ZIPPIN — 0 min changes',    gapMin: 0, extreme: true },
];

// How each change is described once Speedy mode has tightened it.
const FEASIBILITY = {
  comfortable: null,
  tight: null,
  'very-tight': { note: 'one minute — only if the doors are already open', tone: 'warn' },
  improbable: { note: 'same platform, same minute — barely conceivable', tone: 'warn' },
  implausible: { note: 'different platform, same minute — realistically not catchable', tone: 'bad' },
  impossible: { note: 'different station with no time at all — not catchable', tone: 'bad' },
};

const $ = (sel) => document.querySelector(sel);
const form = $('#search');
const statusEl = $('#status');
const resultsEl = $('#results');
const hurryEl = $('#hurry');
const hurryLabel = $('#hurry-label');

let searchToken = 0; // invalidates in-flight renders when a new search starts

// ---------------------------------------------------------------------------
// tiny DOM helper — everything user-visible goes through textContent
// ---------------------------------------------------------------------------

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(opts)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

// ---------------------------------------------------------------------------
// station autocomplete
// ---------------------------------------------------------------------------

function wireCombobox(inputId, listId) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let items = [];
  let cursor = -1;
  let timer;

  const state = { id: null, name: '' };
  input.dataset.stationId = '';

  function close() {
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    cursor = -1;
  }

  function choose(i) {
    const s = items[i];
    if (!s) return;
    input.value = s.name;
    input.dataset.stationId = s.id;
    state.id = s.id;
    state.name = s.name;
    close();
  }

  function highlight(next) {
    cursor = (next + items.length) % items.length;
    [...list.children].forEach((li, i) =>
      li.setAttribute('aria-selected', String(i === cursor)));
  }

  input.addEventListener('input', () => {
    input.dataset.stationId = ''; // typing invalidates a previous pick
    clearTimeout(timer);
    const q = input.value;
    if (q.trim().length < 2) return close();
    timer = setTimeout(async () => {
      let found;
      try { found = await searchStations(q); } catch { return close(); }
      if (input.value !== q) return; // user kept typing
      items = found.slice(0, 8);
      if (!items.length) return close();
      list.replaceChildren(...items.map((s, i) => {
        const li = el('li', { role: 'option', 'aria-selected': 'false', text: s.name });
        li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
        return li;
      }));
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(cursor + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(cursor - 1); }
    else if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); choose(cursor); }
    else if (e.key === 'Escape') close();
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}

/** Turn whatever is in the input into the best {id, name} we can. */
async function resolveStation(input) {
  const name = input.value.trim();
  if (input.dataset.stationId) return { id: input.dataset.stationId, name };
  try {
    const [first] = await searchStations(name);
    if (first) return first;
  } catch { /* fall through — the API also accepts plain names */ }
  return { id: null, name };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function setStatus(text, { busy = false, error = false } = {}) {
  statusEl.className = error ? 'status error' : 'status';
  const parts = [];
  if (busy) parts.push(el('span', { class: 'spinner' }));
  parts.push(document.createTextNode(text));
  statusEl.replaceChildren(...parts);
}

function renderLegs(journey) {
  const body = el('div', { class: 'j-body' });

  journey.rides.forEach((ride, i) => {
    const times = el('div', { class: 'leg-time' }, [
      el('strong', { text: fmtTime(ride.depTs) }),
      el('span', { text: fmtTime(ride.arrTs) }),
    ]);

    const main = el('div', { class: 'leg-main ride' }, [
      el('div', { class: 'leg-station', text: ride.from.name + platSuffix(ride.depPlatform) }),
      el('div', {
        class: 'leg-detail',
        text: ride.headsign ? `${ride.line} → ${ride.headsign}` : ride.line,
      }),
      el('div', { class: 'leg-station', text: ride.to.name + platSuffix(ride.arrPlatform) }),
    ]);

    body.append(el('div', { class: 'leg' }, [times, main]));

    const change = journey.changes[i];
    if (change) body.append(renderChange(change));
  });

  return body;
}

function platSuffix(p) {
  return p ? `  ·  Pl. ${p}` : '';
}

/** Where the platform/station detail for a change goes. */
function changeDetail(change) {
  if (change.walk) return 'walk between stations';
  if (change.arrPlatform && change.depPlatform && change.arrPlatform !== change.depPlatform) {
    return `platform ${change.arrPlatform} → ${change.depPlatform}`;
  }
  if (change.arrPlatform && change.arrPlatform === change.depPlatform) return 'same platform';
  return null;
}

function renderChange(change) {
  const mins = Math.round(change.gapSec / 60);
  const official = change.officialGapSec != null
    ? Math.round(change.officialGapSec / 60)
    : null;
  const tight = mins <= 4;
  const verdict = FEASIBILITY[change.feasibility];

  const row = el('div', {
    class: ['change', tight ? 'tight' : '', verdict ? `is-${verdict.tone}` : ''].filter(Boolean).join(' '),
  });

  // The headline: what the official search claims vs what you'd actually need.
  // Only the genuinely catchable ones get the swagger.
  const doable = !['implausible', 'impossible'].includes(change.feasibility);
  const headline = official != null && official > mins
    ? (doable
      ? `Officially ${official} minutes, but you'll do it in ${mins} 😎`
      : `Officially ${official} minutes — this would leave you ${mins} 😬`)
    : `${mins} min to change`;

  const detail = [`at ${change.station.name}`, changeDetail(change)].filter(Boolean).join(' · ');

  row.append(el('span', { class: 'change-main', text: `${tight ? '🏃 ' : ''}${headline}` }));
  row.append(el('span', { class: 'change-detail', text: detail }));
  if (verdict) row.append(el('span', { class: 'change-verdict', text: verdict.note }));
  return row;
}

function renderNightPanel(journey, cfg) {
  if (!cfg.on) return null;
  // rankNightSplits already annotated every journey in this result set.
  const split = journey.night;
  if (!split || split.status === 'outside') return null;

  const panel = el('div', { class: 'night-panel' }, [
    el('h4', { text: 'Night GA' }),
  ]);

  if (split.status === 'covered') {
    panel.append(el('p', {
      text: 'This whole journey runs inside your night window — no ticket to buy.',
    }));
    return { panel, split };
  }

  panel.append(
    el('p', {}, [
      document.createTextNode('Buy only '),
      el('span', { class: 'split-station', text: journey.from.name }),
      document.createTextNode(' → '),
      el('span', { class: 'split-station', text: split.station.name }),
      document.createTextNode('.'),
    ]),
    el('p', {
      text: `Your train (${split.ride.line}) leaves ${split.station.name} at `
          + `${fmtTime(split.depTs)}, inside the window — everything from there on is covered.`,
    }),
    el('p', {
      class: 'paid-extent',
      text: 'You pay for roughly '
        + [
          split.paidKm != null ? `${Math.round(split.paidKm)} km` : null,
          `${Math.round(split.paidSec / 60)} min`,
        ].filter(Boolean).join(' / ')
        + ' of travel.',
    }),
    el('a', {
      class: 'buy',
      href: sbbLink(journey.from, split.station, journey.depTs),
      target: '_blank',
      rel: 'noopener',
      text: `See price & buy ${journey.from.name} → ${split.station.name} on SBB`,
    }),
    el('p', {
      class: 'caveat',
      text: 'ZIPPIN never shows fares. Check the exact Half Fare price on SBB before buying, '
          + 'and confirm the split matches your Night GA’s own terms.',
    }),
  );

  return { panel, split };
}

function renderJourney(journey, cfg, { speedy = false } = {}) {
  const risky = speedy && journey.changes.some(
    (c) => ['implausible', 'impossible'].includes(c.feasibility));
  const article = el('article', {
    class: ['journey', speedy ? 'is-speedy' : '', risky ? 'is-risky' : ''].filter(Boolean).join(' '),
  });

  const head = el('button', {
    type: 'button', class: 'j-head', 'aria-expanded': 'false',
  });

  const metaBits = [fmtDuration(journey.durationSec)];
  metaBits.push(journey.transfers === 0
    ? 'direct'
    : `${journey.transfers} change${journey.transfers > 1 ? 's' : ''}`);
  if (speedy && journey.minGapSec !== Infinity) {
    metaBits.push(`tightest ${Math.round(journey.minGapSec / 60)} min`);
  }

  const badges = el('div', { class: 'chips' });
  if (speedy) {
    // Head-start trains carry their own badge below; a generic "Speedy" on top
    // of it would say nothing.
    const gain = Math.round((journey.gainSec || 0) / 60);
    if (!journey.headStartSec) {
      const text = gain > 0
        ? (journey.gainKind === 'later' ? `🏃 leave ${gain} min later` : `🏃 ${gain} min earlier`)
        : '🏃 Speedy';
      badges.append(el('span', { class: 'badge speedy', text }));
    }

    // Surface an unrealistic change on the collapsed card too, so an EXTREME
    // result never looks like a normal recommendation.
    if (risky) badges.append(el('span', { class: 'badge risky', text: '⚠️ not realistic' }));
  }

  if (journey.headStartSec > 0) {
    badges.append(el('span', {
      class: 'badge early',
      text: `⏱ leaves ${Math.round(journey.headStartSec / 60)} min early`,
    }));
  }

  const nightInfo = renderNightPanel(journey, cfg);
  if (nightInfo && nightInfo.split.status === 'split') {
    badges.append(el('span', { class: 'badge night', text: '🌙 Shorter ticket' }));
  }

  head.append(
    el('div', { class: 'j-times' }, [
      document.createTextNode(fmtTime(journey.depTs)),
      el('span', { class: 'arrow', text: '→' }),
      document.createTextNode(fmtTime(journey.arrTs)),
    ]),
    el('div', { class: 'j-meta', text: metaBits.join('  ·  ') }),
    badges,
    el('div', { class: 'chips' },
      journey.products.slice(0, 3).map((p) => el('span', { class: 'chip', text: p }))),
    el('span', { class: 'caret', text: '›' }),
  );

  // A one-line summary of what ZIPPIN did, visible without expanding the card —
  // otherwise a speedy result is only distinguishable by a border colour.
  const note = speedy ? el('div', { class: risky ? 'j-note is-bad' : 'j-note' }) : null;
  if (note) {
    if (journey.headStartSec > 0) {
      note.textContent = `⏱ Leaves ${Math.round(journey.headStartSec / 60)} min before the time `
        + 'you asked for — yours only if you are already at the platform.';
    } else {
      const tightened = journey.changes.filter((c) => c.officialGapSec != null);
      note.textContent = tightened.length
        ? `🏃 ${tightened.map((c) => `${c.station.name} in ${Math.round(c.gapSec / 60)} min `
          + `instead of the official ${Math.round(c.officialGapSec / 60)}`).join(';  ')}`
        : '🏃 Tighter than the standard search allows.';
    }
  }

  const body = renderLegs(journey);
  const fb = renderFallback(journey);
  if (fb) body.append(fb);
  if (journey.headStartSec > 0) {
    body.prepend(el('div', {
      class: 'headstart',
      text: `⏱ Departs ${Math.round(journey.headStartSec / 60)} min before the time you asked for — `
        + 'catchable only if you are already at the platform.',
    }));
  }
  if (nightInfo) body.append(nightInfo.panel);
  body.hidden = true;

  head.addEventListener('click', () => {
    const open = head.getAttribute('aria-expanded') === 'true';
    head.setAttribute('aria-expanded', String(!open));
    body.hidden = open;
  });

  article.append(head);
  if (note) article.append(note);
  article.append(body);
  return article;
}

/**
 * What to do if the tight change doesn't come off. Stated as an instruction —
 * where to stand and which train to take — rather than as a caveat.
 */
function renderFallback(journey) {
  const f = journey.fallback;
  if (!f) return null;

  const panel = el('div', { class: 'fallback' }, [
    el('h4', { text: 'If you miss it' }),
  ]);

  if (f.kind === 'onward') {
    const lateBy = Math.round((f.arrTs - journey.arrTs) / 60);
    panel.append(el('p', {
      text: `You are still at ${f.station.name}: take the ${f.line} at ${fmtTime(f.depTs)}`
        + `${f.platform ? ` from platform ${f.platform}` : ''} instead. `
        + `You arrive ${fmtTime(f.arrTs)} — ${lateBy} min later, and exactly what the `
        + 'standard search would have given you anyway.',
    }));
  } else {
    panel.append(el('p', {
      text: `Missing this change costs you the arrival time you asked for. The safe `
        + `alternative is to leave ${f.station.name} at ${fmtTime(f.depTs)} instead, `
        + `arriving ${fmtTime(f.arrTs)}.`,
    }));
  }
  return panel;
}

function groupTitle(text, note) {
  return el('h2', { class: 'group-title' }, [
    document.createTextNode(text),
    note ? el('span', { class: 'count', text: `  ${note}` }) : null,
  ]);
}

/**
 * One list, ordered by what the traveller actually wants: the earliest arrival
 * when departing at a set time, the latest departure when arriving by one.
 *
 * Speedy results are not a separate section — a tightened connection that lands
 * later than a standard one is simply worse, and burying the standard results
 * under it would hide that. Results stream in, so each is inserted in position.
 */
function makeResultList(container, cfg, arriveBy) {
  const cmp = arriveBy
    ? (a, b) => b.depTs - a.depTs || a.arrTs - b.arrTs
    : (a, b) => a.arrTs - b.arrTs || b.depTs - a.depTs;
  const items = [];

  return {
    get count() { return items.length; },
    get journeys() { return items.map((it) => it.j); },
    has(key) { return items.some((it) => it.j.key === key); },
    add(journey, opts) {
      const node = renderJourney(journey, cfg, opts);
      let i = 0;
      while (i < items.length && cmp(journey, items[i].j) >= 0) i++;
      if (i === items.length) container.append(node);
      else container.insertBefore(node, items[i].node);
      items.splice(i, 0, { j: journey, node });
    },
  };
}

/**
 * Both ways to shorten the ticket, side by side.
 *
 * ZIPPIN ranks splits by distance because it cannot see fares — so the runner-up
 * may genuinely be cheaper. Showing one option and calling it best would be
 * claiming knowledge we don't have.
 */
function renderNightCompare(options) {
  if (options.length < 2) return null;

  const card = el('div', { class: 'night-compare' }, [
    el('h3', { text: '🌙 Two ways to shorten your ticket' }),
    el('p', {
      class: 'caveat',
      text: 'ZIPPIN can\'t see fares, so it ranks by how far you\'d pay for — usually, '
        + 'but not always, the cheaper one. Check both on SBB before buying.',
    }),
  ]);

  const list = el('ol', { class: 'split-options' });
  for (const { journey, split } of options.slice(0, 2)) {
    list.append(el('li', {}, [
      el('div', { class: 'split-head', text: `${journey.from.name} → ${split.station.name}` }),
      el('div', {
        class: 'split-meta',
        text: [
          split.paidKm != null ? `~${Math.round(split.paidKm)} km` : null,
          `${Math.round(split.paidSec / 60)} min paid`,
          `on the ${fmtTime(journey.depTs)} departure`,
        ].filter(Boolean).join('  ·  '),
      }),
      el('a', {
        class: 'buy small',
        href: sbbLink(journey.from, split.station, journey.depTs),
        target: '_blank', rel: 'noopener',
        text: 'Check this price on SBB',
      }),
    ]));
  }
  card.append(list);
  return card;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async function runSearch(e) {
  e?.preventDefault();
  const token = ++searchToken;
  const submit = form.querySelector('.go');
  submit.disabled = true;
  resultsEl.replaceChildren();

  const cfg = {
    on: $('#nightga-on').checked,
    start: parseClock($('#night-start').value) ?? 19 * 60,
    end: parseClock($('#night-end').value) ?? 5 * 60,
  };
  const hurry = HURRY[Number(hurryEl.value)];
  const arriveBy = $('#timemode').value === 'arrive';
  const directOnly = $('#direct-only').checked;

  // Only send the mode filter when it actually narrows things; all-selected is
  // the same as unset, and an empty selection would return nothing at all.
  const modes = [...document.querySelectorAll('.mode')].filter((c) => c.checked).map((c) => c.value);
  const allModes = document.querySelectorAll('.mode').length;

  try {
    setStatus('Looking up stations…', { busy: true });
    const [from, to, via] = await Promise.all([
      resolveStation($('#from')),
      resolveStation($('#to')),
      $('#via').value.trim() ? resolveStation($('#via')) : Promise.resolve(null),
    ]);
    if (token !== searchToken) return;
    if (!from.name || !to.name) throw new Error('Please pick both an origin and a destination.');
    if (!modes.length) throw new Error('Pick at least one kind of transport.');

    // Shared by the main search and every Speedy sub-query, so results stay consistent.
    const query = {
      via: via ? (via.id || via.name) : null,
      transportations: modes.length === allModes ? null : modes,
    };

    setStatus('Searching connections…', { busy: true });
    const limit = Number($('#limit').value) || 6;
    // The clock the user gave us: a deadline in arrive-by mode, otherwise the
    // moment they intend to leave.
    const anchorTs = tsFromZurich($('#date').value, $('#time').value);
    if (arriveBy && anchorTs == null) throw new Error('Please give a valid date and time.');

    let base = arriveBy
      ? await connectionsArrivingBy({
        from: from.id || from.name,
        to: to.id || to.name,
        deadlineTs: anchorTs, limit, ...query,
      })
      : await connections({
        from: from.id || from.name,
        to: to.id || to.name,
        date: $('#date').value,
        time: $('#time').value,
        limit, ...query,
      });
    if (token !== searchToken) return;

    // The API accepts `direct` but ignores it (verified), so filter here.
    if (directOnly) base = base.filter((j) => j.transfers === 0);

    if (!base.length) {
      setStatus(directOnly
        ? 'No direct connections found. Untick “Direct connections only” to allow changes.'
        : 'No connections found. Check the station names or try another time.');
      return;
    }

    savePrefs();
    writeUrl();

    // One list for everything, ordered by arrival (or latest departure).
    const title = groupTitle('Connections', `${base.length} found`);
    const holder = el('div', { class: 'results' });
    const nightSlot = el('div');
    resultsEl.append(nightSlot, title, holder);

    const list = makeResultList(holder, cfg, arriveBy);
    const showNight = () => {
      if (!cfg.on) return;
      const { options } = rankNightSplits(list.journeys, cfg.start, cfg.end);
      const card = renderNightCompare(options);
      nightSlot.replaceChildren(...(card ? [card] : []));
    };

    if (cfg.on) rankNightSplits(base, cfg.start, cfg.end);
    for (const j of base) list.add(j);
    showNight();

    if (hurry.gapMin == null || directOnly) {
      setStatus(directOnly
        ? `${base.length} direct connections — no changes to tighten.`
        : `${base.length} connections. Raise the hurry factor to hunt for tighter changes.`);
      return;
    }

    // --- speedy pass ---
    setStatus(`Re-checking every change for ${hurry.gapMin}-minute transfers…`, { busy: true });

    // A "head start" pass: trains leaving shortly *before* the stated time.
    // The planner never offers these — it only looks forward from the clock you
    // gave it — yet if you are already on the platform they are yours to take.
    let headStarts = [];
    if (!arriveBy && anchorTs != null) {
      const earliest = anchorTs - HEAD_START_MIN * 60;
      try {
        const early = await connections({
          from: from.id || from.name,
          to: to.id || to.name,
          date: apiDate(earliest), time: fmtTime(earliest),
          limit: 4, ...query,
        });
        const baseKeys = new Set(base.map((j) => j.key));
        headStarts = early.filter((j) =>
          j.depTs >= earliest && j.depTs < anchorTs && !baseKeys.has(j.key)
          && (!directOnly || j.transfers === 0));
        for (const j of headStarts) {
          j.headStartSec = anchorTs - j.depTs;
          // Missing one of these just means taking the train you'd have caught anyway.
          const next = base[0];
          if (next) {
            j.fallback = {
              kind: 'onward',
              station: from,
              line: next.rides[0].line,
              depTs: next.depTs,
              platform: next.depPlatform,
              arrTs: next.arrTs,
            };
          }
        }
      } catch { /* head start is a bonus; a failure here shouldn't sink the search */ }
    }
    if (token !== searchToken) return;
    for (const j of headStarts) list.add(j, { speedy: true });

    const speedy = await findSpeedy({
      origin: from,
      destination: to,
      // Head-start trains get their changes tightened too.
      baseJourneys: [...base, ...headStarts],
      minGapSec: hurry.gapMin * 60,
      arriveBy,
      query,
      depth: 2,
      onFound: (j) => {
        if (token !== searchToken || list.has(j.key)) return;
        list.add(j, { speedy: true });
      },
    });
    if (token !== searchToken) return;

    title.replaceChildren(
      document.createTextNode('Connections'),
      el('span', { class: 'count', text: `  ${list.count} found` }),
    );
    showNight();

    const extras = [...headStarts, ...speedy];
    if (!extras.length) {
      setStatus(
        `No hidden connections on this route — the standard results already take the `
        + `${arriveBy ? 'latest possible start' : 'earliest onward trains'}. `
        + `(${stats.requests} timetable queries)`,
      );
      return;
    }

    const best = Math.max(0, ...speedy.map((j) => j.gainSec || 0));
    const unrealistic = extras.filter((j) =>
      j.changes.some((c) => ['implausible', 'impossible'].includes(c.feasibility))).length;

    const parts = [];
    if (speedy.length) {
      const n = `${speedy.length} tighter connection${speedy.length > 1 ? 's' : ''}`;
      parts.push(best > 0
        ? `Found ${n} — ${arriveBy
          ? `you could leave up to ${Math.round(best / 60)} min later.`
          : `up to ${Math.round(best / 60)} min earlier at your destination.`}`
        : `Found ${n}.`);
    }
    if (headStarts.length) {
      parts.push(`${headStarts.length} train${headStarts.length > 1 ? 's leave' : ' leaves'} `
        + 'just before your stated time — catchable if you are already there.');
    }
    let msg = parts.join('  ');
    if (unrealistic) {
      msg += unrealistic === 1
        ? '  One of them needs a change that isn\'t realistically catchable.'
        : `  ${unrealistic} of them need a change that isn't realistically catchable.`;
    }
    setStatus(msg);
  } catch (err) {
    if (token !== searchToken) return;
    const msg = err instanceof ApiError
      ? err.message
      : (err?.message || 'Something went wrong. Try again.');
    setStatus(msg, { error: true });
  } finally {
    if (token === searchToken) submit.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// preferences
// ---------------------------------------------------------------------------

const PREFS = 'zippin.prefs.v1';

function savePrefs() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({
      from: $('#from').value, fromId: $('#from').dataset.stationId,
      to: $('#to').value, toId: $('#to').dataset.stationId,
      hurry: hurryEl.value,
      timemode: $('#timemode').value,
      limit: $('#limit').value,
      directOnly: $('#direct-only').checked,
      modes: [...document.querySelectorAll('.mode')].filter((c) => c.checked).map((c) => c.value),
      night: $('#nightga-on').checked,
      nightStart: $('#night-start').value,
      nightEnd: $('#night-end').value,
    }));
  } catch { /* private mode — preferences just don't persist */ }
}

function loadPrefs() {
  let p;
  try { p = JSON.parse(localStorage.getItem(PREFS) || 'null'); } catch { return; }
  if (!p) return;
  $('#from').value = p.from || '';
  $('#from').dataset.stationId = p.fromId || '';
  $('#to').value = p.to || '';
  $('#to').dataset.stationId = p.toId || '';
  hurryEl.value = p.hurry ?? '1';
  if (p.timemode) $('#timemode').value = p.timemode;
  if (p.limit) $('#limit').value = p.limit;
  $('#direct-only').checked = !!p.directOnly;
  if (Array.isArray(p.modes) && p.modes.length) {
    for (const c of document.querySelectorAll('.mode')) c.checked = p.modes.includes(c.value);
  }
  $('#nightga-on').checked = !!p.night;
  if (p.nightStart) $('#night-start').value = p.nightStart;
  if (p.nightEnd) $('#night-end').value = p.nightEnd;
  if (p.night) document.querySelector('.nightga').open = true;
  if (p.directOnly || (Array.isArray(p.modes) && p.modes.length && p.modes.length < 5)) {
    document.querySelector('.more').open = true;
  }
}

// ---------------------------------------------------------------------------
// shareable links
// ---------------------------------------------------------------------------

/** Reflect the current search in the address bar so the link can be shared. */
function writeUrl() {
  const p = new URLSearchParams();
  p.set('from', $('#from').value);
  p.set('to', $('#to').value);
  p.set('date', $('#date').value);
  p.set('time', $('#time').value);
  if ($('#timemode').value === 'arrive') p.set('mode', 'arrive');
  if (hurryEl.value !== '1') p.set('hurry', hurryEl.value);
  if ($('#via').value.trim()) p.set('via', $('#via').value.trim());
  if ($('#limit').value !== '6') p.set('limit', $('#limit').value);
  if ($('#direct-only').checked) p.set('direct', '1');

  const modes = [...document.querySelectorAll('.mode')].filter((c) => c.checked).map((c) => c.value);
  if (modes.length !== document.querySelectorAll('.mode').length) p.set('modes', modes.join(','));

  if ($('#nightga-on').checked) {
    p.set('night', '1');
    p.set('ns', $('#night-start').value);
    p.set('ne', $('#night-end').value);
  }
  history.replaceState(null, '', `${location.pathname}?${p}`);
  $('#share').hidden = false;
}

/** Populate the form from ?query parameters. Returns true if a search was described. */
function readUrl() {
  const p = new URLSearchParams(location.search);
  if (!p.get('from') || !p.get('to')) return false;

  $('#from').value = p.get('from');
  $('#to').value = p.get('to');
  if (p.get('date')) $('#date').value = p.get('date');
  if (p.get('time')) $('#time').value = p.get('time');
  $('#timemode').value = p.get('mode') === 'arrive' ? 'arrive' : 'depart';
  hurryEl.value = p.get('hurry') ?? '1';
  $('#via').value = p.get('via') || '';
  if (p.get('limit')) $('#limit').value = p.get('limit');
  $('#direct-only').checked = p.get('direct') === '1';

  if (p.get('modes')) {
    const want = p.get('modes').split(',');
    for (const c of document.querySelectorAll('.mode')) c.checked = want.includes(c.value);
  }
  $('#nightga-on').checked = p.get('night') === '1';
  if (p.get('ns')) $('#night-start').value = p.get('ns');
  if (p.get('ne')) $('#night-end').value = p.get('ne');
  if (p.get('night') === '1') document.querySelector('.nightga').open = true;
  if (p.get('via') || p.get('direct') || p.get('modes')) document.querySelector('.more').open = true;
  return true;
}

async function copyLink() {
  const btn = $('#share');
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = '✓ Link copied';
  } catch {
    btn.textContent = 'Press ⌘C to copy';
    // Clipboard access can be denied; select the URL so the user can copy it.
    const r = document.createRange();
    r.selectNodeContents(btn);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }
  setTimeout(() => { btn.textContent = '🔗 Copy link to this search'; }, 2500);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

wireCombobox('from', 'from-list');
wireCombobox('to', 'to-list');
wireCombobox('via', 'via-list');

$('#date').value = todayInZurich();
$('#time').value = nowInZurich();

function syncHurry() {
  const h = HURRY[Number(hurryEl.value)];
  hurryLabel.textContent = h.label;
  hurryLabel.classList.toggle('is-extreme', !!h.extreme);
  $('#extreme-warn').hidden = !h.extreme;
}
hurryEl.addEventListener('input', syncHurry);

function syncTimeMode() {
  $('#time-label').textContent = $('#timemode').value === 'arrive' ? 'Arrival' : 'Departure';
}
$('#timemode').addEventListener('change', syncTimeMode);

$('#swap').addEventListener('click', () => {
  const a = $('#from'), b = $('#to');
  [a.value, b.value] = [b.value, a.value];
  [a.dataset.stationId, b.dataset.stationId] = [b.dataset.stationId, a.dataset.stationId];
});

$('#nightga-on').addEventListener('change', (e) => {
  if (e.target.checked) document.querySelector('.nightga').open = true;
});

form.addEventListener('submit', runSearch);
$('#share').addEventListener('click', copyLink);

// A shared link wins over stored preferences, and runs itself.
loadPrefs();
const fromLink = readUrl();
syncHurry();
syncTimeMode();
if (fromLink) runSearch();
