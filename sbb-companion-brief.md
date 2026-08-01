# Project brief: SBB companion web app ("smarter journey planner")

## One-line summary
A static website that queries Swiss public-transport open data and surfaces connections the official SBB app hides — connections you'd catch if you walked fast, and cheaper partial tickets when part of a trip falls in a discount window.

## Why it's a website, not a plugin or an app
- The SBB Mobile app is closed — no plugin/extension can run inside it. Discard any "augment the SBB app" idea.
- A browser cannot inject into sbb.ch either (cross-origin security). So this is **our own thin UI on top of the open transport API**, not a wrapped/augmented SBB. Decide this from day one.
- Website chosen over a native iOS app to avoid Apple's code-signing hassle (free personal signing expires every 7 days; sharing with friends needs a paid $99/yr account). A static site is free to host, has no expiry, and shares via a single URL.

## Two features

### 1. Speedy mode (build this first — cleaner, no fare logic)
Problem: SBB pads walking/transfer times for a slow walker, so it hides connections a quick walker could actually catch.
Solution: given A → Z and a time, query the journey planner with **reduced walking speed / minimum transfer time** and show the more aggressive connections SBB's defaults omit.
- Make the "hurry factor" **tunable**, not literally zero — zero-walk surfaces genuinely uncatchable connections. A slider (e.g. "normal → quick → sprint") lets the user trust the result.
- The open APIs expose walk/transfer as parameters, so this is a supported query, not a hack.

### 2. Night-GA / partial-ticket helper (second, harder)
Context: with a Night GA (free travel in the night window) plus a Half Fare, if you're travelling A → Z and part of the trip crosses into the night window (e.g. after 19:00), you only need to *buy* the portion before the window starts.
Behaviour: given A → Z and the current time, scan the connection's stop sequence to find **station I = the first stop the train departs after 19:00**. The ticket to buy is A → I. Show that suggestion so the user doesn't have to manually open the trip, read the stops, and re-search A → I as a separate trip.
- **Fares are the weak joint.** There is no reliable open API for exact Swiss point-to-point Half Fare prices. Show the split station and the train; treat any price as an *estimate*, or omit price and just deep-link to SBB's A → I search so the user sees the real price and buys there.
- Do **not** scrape live SBB fares — fragile and against terms.

## Data source
- `transport.opendata.ch` — free, no API key, returns full stop sequence with per-stop times; supports walk/transfer params. Good default.
- Official Open Journey Planner (OJP) is the alternative if more coverage/accuracy is needed.
- **Likely snag:** calling the API directly from the browser may hit CORS. If so, add a tiny Cloudflare Workers proxy (free tier). Don't pre-build it — it's the escape hatch, not the plan.

## Purchases
Never handle payment or fares directly. For the buy, **deep-link out to SBB** (prefill from/to where possible) and let the user finish in the real SBB site/app.

## Tech + hosting
- Static single-page app. Vanilla HTML/JS is enough; a light framework (Svelte/React) is fine if preferred.
- Host on **Cloudflare Pages or GitHub Pages** — free, HTTPS, shareable URL. Optional custom domain ~10–15 CHF/yr.
- No backend needed unless the CORS proxy becomes necessary.

## Suggested build order
1. Skeleton: one page, A → Z + time inputs, call the API, list normal connections. Get it running end to end.
2. Speedy mode: add the hurry-factor param, show the aggressive connections.
3. Night-GA helper: stop-sequence scan for station I, show the A → I suggestion + deep-link.
4. Deploy to Pages, share the URL.

## Explicit non-goals / constraints
- No embedding into or scraping of the SBB app or site.
- No live fare scraping; prices are estimates or deferred to SBB.
- Not aiming for App Store distribution; a shared URL is the distribution.
