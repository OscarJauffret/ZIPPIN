# ZIPPIN

*ama**Z**e speed**I**er chea**P**er tri**P**s **I**n switzerla**N**d*

A static web app over Swiss public-transport open data. Two things the official
search won't do for you:

1. **Speedy mode** — surfaces connections you'd catch if you walked fast, which the
   default search hides because it pads transfer times for a slow walker.
2. **Night-GA helper** — when part of a trip falls inside your Night GA window, it
   finds the station you only need to buy a ticket *to*.

> ZIPPIN is a separate site built on public open data, not a plugin — the SBB app is
> closed and browsers can't inject into sbb.ch. No affiliation with SBB.

No build step, no backend, no API key. Open `index.html` through any static server.

```bash
python3 -m http.server 8788
```

Then <http://localhost:8788>.

---

## How Speedy mode actually works

The original plan was to pass a walking-speed / minimum-transfer-time parameter to
the journey planner. **Neither keyless Swiss API supports one.** Verified empirically
against several routes — `transport.opendata.ch` and `timetable.search.ch` both return
byte-identical results with `transferTime`, `minTransferTime`, `walkSpeed`,
`footpathTime`, `changeTime`, `interchange_time` set. They are silently ignored.
(The official OJP endpoint does expose walk-speed parameters, but it needs an API key
from opentransportdata.swiss, which would end the "free, no signup" property.)

So the effect is reconstructed client side. The key observation:

> The padding that hides tight connections is applied to **through** searches. A fresh
> search *starting at an intermediate station* has no incoming transfer to pad, so it
> will happily offer a train leaving two minutes from now.

Speedy mode exploits exactly that ([js/plan.js](js/plan.js)), in whichever direction
the traveller actually cares about:

| Search mode | What it re-searches | What you win |
|---|---|---|
| **Depart at** | onward from each change | arrive earlier |
| **Arrive by** | the run-up to each change | leave later |

1. Take a standard A→Z result.
2. At each change, re-search the relevant half at the precise arrival/departure time.
3. If a train turns up that the padded search skipped, splice it in and report the
   real gap in minutes.
4. Recurse one level deeper on anything it finds.

Each tightened change is reported against what the standard search claimed:

> 🏃 **Officially 5 minutes, but you'll do it in 3 😎** — at Zürich HB · platform 15 → 7

This makes the hurry factor **better than the briefed version**: rather than an opaque
speed multiplier, the slider is a floor on the actual gap between your train arriving
and the next one leaving, and you see both numbers side by side.

### ZIPPIN mode

The slider's last stop allows **zero-minute** changes. As the brief predicted, this
surfaces genuinely uncatchable connections, so ZIPPIN grades every change rather than
presenting them as recommendations:

| Gap | Verdict |
|---|---|
| ≥ 5 min | comfortable |
| 2–4 min | tight |
| 1 min | *only if the doors are already open* (or **implausible** if it needs a walk) |
| 0 min, same platform | **improbable** |
| 0 min, different platform | **implausible** |
| 0 min, different station | **impossible** |

Anything implausible or worse also gets a "⚠️ not realistic" badge on the collapsed
card, and the result count says how many are affected.

### One list, and a way out

Speedy results are **not** a separate section. Raising the hurry factor only ever adds
options — you can always walk slower — so everything lands in a single list ordered by
what you actually care about: earliest arrival when departing at a set time, latest
departure when arriving by one. A tightened connection that arrives later than a
standard one sorts below it, because it is simply worse.

Because they share one list, aggressive results are marked three ways on the collapsed
card — a coloured left edge, a badge (`🏃 3 min earlier`), and a one-line summary of
what was actually changed, so you never have to expand a card to see why it's there:

> 🏃 **Zürich HB in 3 min instead of the official 5**
> ⏱ **Leaves 5 min before the time you asked for** — yours only if you are already at the platform
> 🏃 **Zürich HB in 0 min instead of the official 5** *(red, on unrealistic results)*

Standard connections carry no marking at all.

Every aggressive result also states what to do if the sprint fails, in the imperative:

> **If you miss it** — You are still at Zürich HB: take the IR 75 at 10:35 from
> platform 6 instead. You arrive 11:02 — 3 min later, and exactly what the standard
> search would have given you anyway.

That is the point of the fallback: on a depart-at search the gamble is usually **free**,
because missing it drops you back onto the journey you'd have taken regardless. On an
arrive-by search it isn't — missing the change costs you the arrival time you asked for
— so there the fallback names the safer, earlier departure instead.

**Worked example** — Yverdon-les-Bains → Zug, 03.08.2026, 08:00:

| | Departs | Arrives | Change at Zürich HB |
|---|---|---|---|
| Standard search | 08:32 | 11:02 | 5 min (10:30 → 10:35) |
| Speedy | 08:32 | **10:59** | 3 min (10:30 → 10:33) |

Same first train, three minutes earlier at the destination, because the 10:33 exists
and the padded search refuses to offer it.

Hit rate is honestly low — most routes already take the earliest onward train, and the
app says so plainly rather than inventing results. It pays off at busy hubs.

### The head start

Speedy mode also runs a second, much higher-yield pass. The planner only ever looks
*forward* from the clock you typed, so a train leaving three minutes before your stated
time is invisible to it — even though, if you're already on the platform, it's yours.

ZIPPIN re-queries from `stated time − 5 min` and surfaces anything in that window,
labelled for exactly what it is:

> ⏱ **Departs 5 min before the time you asked for** — catchable only if you are already
> at the platform.

Zürich HB → Winterthur asking for 09:07: the official first result is 09:16 → 09:38.
ZIPPIN also offers the 09:02 → 09:27 and 09:04 → 09:29 — **eleven minutes earlier** at
the destination. This fires on most frequent-service routes, unlike the transfer
rearrangement.

## Search options, and which ones are real

Every parameter was tested against the live endpoint before being exposed, because
several documented ones don't work:

| Option | Status |
|---|---|
| Depart at / **Arrive by** | works, but needs a workaround — see below |
| Via station | `via` — honoured |
| Transport modes (train/tram/bus/boat/cable car) | `transportations[]` — honoured |
| Number of results | `limit` — honoured |
| Direct connections only | `direct` is **ignored** by the API → filtered client side |
| Bike / accessibility | **ignored** by the API → not offered rather than shipped dead |
| Sleeper / couchette | untestable (no international coverage on this endpoint) → omitted |

### The "arrive by" workaround

`isArrivalTime=1` is close to useless as shipped. It returns a window that ends well
*before* the requested time, and raising `limit` extends that window **backwards**:

```
Yverdon-les-Bains → Zürich HB, "arrive by 10:30"
  limit=4 → latest result arrives 09:30
  limit=8 → latest result still arrives 09:30, earliest now 07:28
```

You never get the trains you'd actually take. So [js/api.js](js/api.js) estimates the
journey duration, searches *forwards* from `deadline − duration − slack`, and keeps the
latest results that still arrive in time. Yverdon → Zug "arrive by 12:00" goes from
returning 09:02–09:59 to returning 10:29–11:29.

## How the Night-GA helper works

For each connection it walks the full stop sequence (`passList`, which carries per-stop
times) and finds the first stop the train **departs** inside your night window. That
station is the split point: everything from there on is covered, so you only buy
origin → split.

Lausanne → Zürich HB departing 18:34 on IC 5 splits at **Yverdon-les-Bains** (departs
19:02 — the first departure at or after 19:00). Verified against the raw stop list.

The window is configurable (defaults 19:00–05:00) and wraps past midnight correctly.
Three outcomes are handled: a split station, "whole journey already covered", and
"no part of this trip is in the window" (no panel shown).

### Hunting for the cheapest split

A connection that leaves *later* can cross into the night window much earlier in its
route, leaving a far shorter stretch to pay for. So ZIPPIN compares the split across
the whole result set — and then shows **both** candidates side by side, each with its
own SBB link.

It deliberately does not crown a winner. The ranking is a distance proxy, and distance
is not price: fare tiers, supersaver availability and route specifics can easily make
the runner-up cheaper. Picking one and labelling it "cheapest" would be claiming
knowledge ZIPPIN doesn't have. It ranks, says why, and sends you to SBB to compare.

Ranking needs a fare proxy, and straight-line distance is a bad one — two split
stations can sit equidistant from the origin as the crow flies while the routes to them
differ. Instead ZIPPIN sums great-circle hops **along the actual stop sequence**, which
tracks rail distance closely. Lausanne → Zürich HB at 18:15:

| Departs | Split at | Paid stretch |
|---|---|---|
| 18:34 | Yverdon-les-Bains | ~32 km / 28 min |
| 18:40 | Romont FR | ~34 km / 33 min |

Both are ~29 km in a straight line, so crow-flight distance couldn't separate them at
all. These are distances, never prices — ZIPPIN still doesn't know what anything costs.

## Shareable links

Every search is reflected into the query string, and opening such a link restores the
form and runs it. A **🔗 Copy link** button sits next to the results. Since the whole
app is distributed as a URL, so are individual searches — a commute is just a bookmark.

### Fares

**ZIPPIN never shows a price and never handles payment.** There is no reliable open
API for Swiss point-to-point Half Fare prices, and scraping live SBB fares is fragile
and against their terms. The app shows the split station and the train, then deep-links
to SBB's own timetable prefilled with origin → split station, where the real price is
shown and the ticket is bought.

## Data source

[`transport.opendata.ch`](https://transport.opendata.ch) — free, no API key,
`Access-Control-Allow-Origin: *`. **No CORS proxy is needed**, so the Cloudflare Worker
escape hatch stayed unbuilt.

The endpoint is rate limited per IP. Speedy mode fans out into up to 24 extra queries
per search, so [js/api.js](js/api.js) caches every response for the page's lifetime,
dedupes in-flight requests, and caps concurrency at 4. "Normal" on the slider makes
exactly one request.

## Sharing it

### A link (best)

Static files, nothing to build.

**Cloudflare Pages** — connect the repo, leave the build command empty, set the output
directory to `/`. Or drag the folder straight into the dashboard.

**GitHub Pages** — push, then Settings → Pages → deploy from branch, root folder.

```bash
git init && git add -A && git commit -m "ZIPPIN"
```

A URL is the best distribution: individual searches are shareable links too, and
updates reach everyone without resending anything.

### A single file (no hosting)

To send it directly instead — email, chat, USB stick:

```bash
python3 build.py
```

That writes **`zippin.html`**, ~77 KB, everything inlined. Your friend double-clicks it
and it runs. No install, no server, no build tools, works offline apart from the
timetable lookups.

**Don't just zip the source folder.** The app is written as ES modules, and browsers
refuse to load those over `file://` — the origin is `null`, so the module fetch is
blocked and the page comes up blank. `build.py` exists precisely to sidestep that: it
inlines the CSS and concatenates the four modules into one classic script inside an
IIFE. (The API itself is fine from `file://` — it sends
`Access-Control-Allow-Origin: *`, which permits a null origin. Verified.)

Re-run `build.py` after any source change; `zippin.html` is a build artifact, not
something to edit by hand.

## Layout

| File | |
|---|---|
| [index.html](index.html) | markup |
| [styles.css](styles.css) | styling, light + dark |
| [js/api.js](js/api.js) | API client, caching, response normalisation |
| [js/plan.js](js/plan.js) | Speedy recombination + Night-GA split |
| [js/app.js](js/app.js) | UI, autocomplete, rendering |
| [js/time.js](js/time.js) | Europe/Zurich formatting (correct from any timezone) |
| [build.py](build.py) | bundles everything into a single shareable `zippin.html` |

## No AI, no backend, no keys

Every string in the UI is a template literal in the source — including the "if you miss
it" instructions, which interpolate station, line, platform and times into two fixed
sentences in `renderFallback()`. There is no model call anywhere.

The whole app makes **exactly one** `fetch()`, in [js/api.js](js/api.js), to
transport.opendata.ch. The only other external host is sbb.ch, and only when you click
a deep link. No API keys, no analytics, no third-party scripts, no build step.

## Caveats

- Live delays are **not** applied. A 3-minute change assumes both trains run to
  schedule. The API does expose a per-stop `prognosis` with real-time delays, so
  greying out a tight change when the incoming train is already late is the obvious
  next step.
- The Night GA split follows the brief's rule (first stop departing after the window
  opens). Confirm it against your own subscription's terms.
- Not affiliated with SBB CFF FFS.
