# UI/UX audit — ZIPPIN

**URL audited:** https://oscarjauffret.github.io/ZIPPIN/ (single-page app; all states reached via query params)
**Date:** 2026-08-02
**Tested at:** 1440×900, 768×1024, 390×844, plus 320×800 for WCAG reflow · Chrome, light and dark
**Standards applied:** Nielsen usability heuristics, WCAG 2.2 AA
**Source cross-referenced:** local repo at `/Users/oscar/code/web/sbb` — line numbers below are from `index.html`, `styles.css`, `js/app.js`

> Tooling note: the keyboard, ARIA and contrast work was done in Chrome via the extension. Chrome's window resize did not propagate to the render viewport (`outerWidth` changed, `innerWidth` stayed 1512), so the three breakpoints were measured in the in-app browser instead, which controls the viewport directly.

---

## Summary

ZIPPIN is a Swiss journey planner whose pitch is that it finds connections the official search hides by assuming a faster walker. The primary action is Search; the secondary flows are the hurry-factor slider, the Night GA ticket-splitting panel, and the shareable link.

The build is genuinely solid underneath — complete keyboard reachability, honest copy, reduced-motion support, no layout breakage at any width, 31 KB total. The problems cluster in two places. First, **the app never tells you its results are out of date**: change the hurry factor and the results below stay exactly as they were, with no indication that no search was run — which makes the app's headline feature look like it does nothing. Second, **zero-result and error states are undiagnosed and unstyled**: a search emptied by the user's own filter reports "Check the station names", in the same grey as a success message.

| Severity | Count |
|---|---|
| Blocker | 0 |
| Critical | 2 |
| Major | 8 |
| Minor | 7 |
| Polish | 1 |

**Fix these first:**

1. **F1** — Mark results stale when a search setting changes (one class + one status line).
2. **F2** — Say *why* zero results happened, and style it as an error.
3. **F6** — Add `color-scheme: light dark`. One line; fixes invisible date/time picker icons and every native popup in dark mode.
4. **F5** — Dark-mode `--accent` and `--night` are used as fills behind white text at 2.4:1 and 3.0:1.
5. **F3** — `Max changes` isn't in the share URL, so "Copy link to this search" hands over a different search.

**What works well:**

- **Keyboard access is complete and correct.** Tabbing from the top reached all 13 controls in visual order, nothing was trapped, and every one had a visible focus ring. That is rarer than it should be.
- **Light mode has zero contrast failures.** A full text-node scan of the rendered page (including expanded results and the Night GA panel) returned nothing below threshold. Every failure in this report is dark-mode-only.
- **`prefers-reduced-motion` is honoured** (`styles.css:406-408`) — the spinner stops and all transitions are disabled.
- **No horizontal overflow at any width tested**, including 320px. WCAG 1.4.10 Reflow passes cleanly.
- **The copy is honest where it costs something to be** — the zero-minute-change warning, "Live delays are not applied", and "ZIPPIN can't see fares, so it ranks by how far you'd pay for, usually but not always the cheaper one" are caveats most projects would quietly omit.

---

## Findings

### F1 · Mark results stale when a search setting changes — Critical

**Where:** Hurry slider (`index.html:128-148`); handler at `js/app.js:994` (`hurryEl.addEventListener('input', syncHurry)`). Same applies to `#max-changes`, `#limit`, `#via`, `.mode`, `#direct-only`, `#nightga-on`, `#date`, `#time`, `#from`, `#to`.
**Observed:** With six results on screen from a `hurry=1` (Quick) search of Lausanne → Zürich HB, I moved the slider to maximum. The label changed to "ZIPPIN — 0 min changes" and the zero-minute warning appeared. The six result rows and the status line — "No hidden connections on this route — the standard results already take the earliest onward trains. (6 timetable queries)" — were left completely untouched. `syncHurry` (`app.js:988-992`) only updates the label text and a CSS class; there is no staleness handling anywhere in the file (no `stale` or `dirty` state exists).
**Impact:** The hurry factor is the entire reason this app exists. A user who raises it to ZIPPIN, looks down, and sees the same six connections and the same "no hidden connections" message will conclude the feature found nothing — when in fact no search was run. The screen is asserting a result for settings it was never given. Nielsen #1, visibility of system status.
**Fix:** On `input`/`change` of any search-affecting control, if `#results` has children, add `.is-stale` to it (`opacity:.45; pointer-events:none`) and call `setStatus('Settings changed — press Search to update.')`. Clear both at the top of the submit handler, next to the existing `resultsEl.replaceChildren()` at `app.js:628`.
**Evidence:** `ss_6356nwmvq` (slider at ZIPPIN, stale Quick-mode results and status below it)

---

### F2 · Zero-result message blames the wrong thing and isn't styled as a problem — Critical

**Where:** `js/app.js:690-694`
**Observed:** Searching Lausanne → Zermatt on 2026-08-03 at 08:00 with **Max changes = "Direct only"** (a route with no direct service) produced: *"No connections found. Check the station names or try another time."* Both station names were valid and had resolved successfully; the time was fine. The cause was the user's own filter, applied client-side at `app.js:688` — the app had the unfiltered list in hand and knew exactly why it emptied. Additionally, `setStatus` is called here **without** `{ error: true }`, so `statusEl.className` stayed `"status"` and the text rendered in `#626b78` — the identical muted grey used for *"6 connections found"*. The `.status.error` style exists (`app.js:164`) but is only reached from the exception handler at `app.js:852`.
**Impact:** WCAG 3.3.1 Error Identification (Level A) — the item causing the error is not identified. The user is explicitly directed to debug the one thing that was correct. And nothing visually distinguishes total failure from success, so the outcome is easy to miss entirely.
**Fix:** Capture `base.length` before the two filters at `app.js:685-688`. If it was non-empty and is now zero, name the responsible filter: *"6 connections found, but none with 0 changes. Raise 'Max changes' to see them."* Pass `{ error: true }` on every zero-result path so the existing error styling applies.
**Evidence:** screenshot at 768px showing "Max changes: Direct only" and the misleading grey status together

---

### F3 · "Copy link to this search" produces a link that runs a different search — Major

**Where:** `js/app.js:910-932` (`writeUrl`), `935-958` (`readUrl`)
**Observed:** With `Max changes = "Direct only"` set and a zero-result search on screen, the address bar read `?from=Lausanne&to=Zermatt&date=2026-08-03&time=08%3A00&hurry=4`. `#max-changes` is serialised by neither function — while `#direct-only` (`:920`), `#limit` (`:919`), `#via` (`:918`) and `.mode` (`:922-923`) all are. Following that link reproduces the search *without* the changes cap and returns six results.
**Impact:** The sender saw zero connections; the recipient sees six. Silent, invisible divergence in the one feature whose only job is to reproduce a search faithfully.
**Fix:** In `writeUrl`, add `if ($('#max-changes').value) p.set('maxch', $('#max-changes').value);`. In `readUrl`, `if (p.get('maxch')) $('#max-changes').value = p.get('maxch');` and add `p.get('maxch')` to the `.more`-auto-open condition at `:957`.

---

### F4 · Combobox arrow keys select off-screen, unannounced options — Major

**Where:** `js/app.js:89-93` (`highlight`), `106-113` (option construction)
**Observed:** Typing "Laus" returned 8 suggestions in a list with `max-height: 240px` showing roughly 6.4 of them. Seven ArrowDown presses set `aria-selected="true"` on "Lausanne-Flon" (index 6), whose rect was top 421.4 / bottom 457.8 against a list bottom of 437.6 — **below the visible area** — while `list.scrollTop` remained 0. Separately, the input never receives `aria-activedescendant` (measured `null`) and the `<li role="option">` elements are created without `id` attributes (all 8 returned `"(none)"`).
**Impact:** Two failures in one control. Sighted keyboard users past item ~6 are selecting an option they cannot see. Screen reader users hear nothing at all as the cursor moves, because `aria-selected` on an option the user isn't focused on is not announced — the combobox pattern requires `aria-activedescendant` to move the virtual cursor. WCAG 4.1.2 Name, Role, Value (Level A) on the app's first and most-used control.
**Fix:** In the map at `:106-110`, add `li.id = listId + '-opt-' + i`. In `highlight()`, after setting `aria-selected`, add `input.setAttribute('aria-activedescendant', list.children[cursor].id)` and `list.children[cursor].scrollIntoView({ block: 'nearest' })`. In `close()` (`:72-77`), `input.removeAttribute('aria-activedescendant')`.
**Evidence:** `ss_9488jdnum` (after 7 ArrowDowns, no visible highlight anywhere in the list)

---

### F5 · Dark-mode fills put white text at 2.4:1 and 3.0:1 — Major

**Where:** `styles.css:28` (`--accent: #ff5d70`) and `:32` (`--night: #a99bff`), used as `background` by `.go` (`:131-136`) and the `.buy` link classes
**Observed (dark mode only):**

| Element | Foreground | Background | Size/weight | Ratio | Required |
|---|---|---|---|---|---|
| "Search" (primary CTA) | `#FFFFFF` | `#FF5D70` | 16px / 600 | **2.98:1** | 4.5:1 |
| "Lausanne → Yverdon-les-Bains · 18:34" | `#FFFFFF` | `#A99BFF` | 12.2px / 600 | **2.38:1** | 4.5:1 |
| "Lausanne → Romont FR · 18:40" | `#FFFFFF` | `#A99BFF` | 12.2px / 600 | **2.38:1** | 4.5:1 |
| "Check price on SBB · 18:34 → 19:00" | `#FFFFFF` | `#A99BFF` | 12.2px / 600 | **2.38:1** | 4.5:1 |

Re-running the identical scan against the light palette returned **zero** failures — light `--accent: #d2001e` gives 5.59:1 and `--night: #4b3bd4` gives 7.30:1 against white.
**Impact:** WCAG 1.4.3 Contrast (Minimum), Level AA. The two worst-contrast elements on the page are the primary CTA and every link to actually buying a ticket. The cause is structural: the dark block lightens these tokens so they work as *foreground* colours, but they are also used as *fills*, where lightening makes white text worse.
**Fix:** Split the roles. Add to the dark block: `--accent-fill: #b3122b; --night-fill: #4032b0;` and use those for `background` on `.go` and `.buy`, keeping `--accent`/`--night` for text and borders. Both give >4.5:1 against white.

---

### F6 · Native date/time picker icons are near-black on the dark surface — Major

**Where:** `styles.css` — the dark theme is declared only via `@media (prefers-color-scheme: dark)` (`:20-38`); there is no `color-scheme` property anywhere in the file.
**Observed:** The calendar indicator on `#date` and the clock indicator on `#time` render in the UA's light-mode dark ink on `--surface-2: #1f242d`. Zooming in on the two fields shows both glyphs as near-black shapes barely separable from the field they sit in.
**Impact:** Two of the four required search fields have an effectively invisible affordance in dark mode. Because the UA doesn't know the page is dark, this also means the date-picker popup, the time-picker popup, every `<select>` dropdown and the scrollbars all render as light-on-light panels inside a dark page.
**Fix:** `:root { color-scheme: light dark; }`. One line — the UA then inverts the indicators and themes all native popups to match.
**Evidence:** zoom of the Date and Departure fields at 1440

---

### F7 · 604px of blank space silently toggles Night GA — Major

**Where:** `index.html:151-156` — a `<label class="inline-check">` wrapping the checkbox, placed inside `<summary>`
**Observed:** The label computes to `display: flex` at **842.8px** wide, while its visible text ("I have a Night GA (+ Half Fare)") ends at x=573. I clicked at x=800, y=498 — 227px past the last character, on what looks like empty card background — and `#nightga-on.checked` went from `false` to `true`, opening the panel. `document.elementFromPoint(800, 498)` confirms the label occupies that point.
**Impact:** Users clicking the summary row to expand a disclosure instead enable a fare option that changes every result and injects an entire panel above the connections list. The action taken is not the one the pointer appeared to be over. At 390px the same pattern applies to `#direct-only`'s label (321px wide for ~150px of text).
**Fix:** `.nightga summary label.inline-check, .more > label.inline-check { display: inline-flex; }` so the hit area matches the visible text. The five transport-mode labels (`index.html:114-118`) already size to content inside their flex row and are fine.

---

### F8 · Result rows announce as one run-on string including decorative glyphs — Major

**Where:** `js/app.js:332` — the `.j-head` disclosure button
**Observed:** The accessible name of the first result is `"17:04→19:302h 26 · 1 changeIC 51IR 55›"`. There is no separator between the arrival time and the duration, and both the `→` and the `›` caret are inside the name. None of the six buttons carry `aria-controls` for the panel they toggle (`aria-expanded` is correctly maintained).
**Impact:** A screen reader reads "19:30 2h 26" as an unbroken number run, and announces the decorative chevron as content. This is the primary result list — the main thing on the page a user needs to read and compare.
**Fix:** Add `aria-hidden="true"` to the `→` separator and the `.caret` element. Give the button an explicit label: `aria-label="17:04 to 19:30, 2 hours 26 minutes, 1 change, IC 51 then IR 55"`. Add `aria-controls` pointing at the `.j-body` id.

---

### F9 · Swap and Copy-link succeed with no accessible confirmation — Major

**Where:** `js/app.js:961-975` (`copyLink`), `1001-1005` (swap handler)
**Observed:** `copyLink` swaps `btn.textContent` to "✓ Link copied" for 2500ms. The button has no `aria-live` (`null`) and is not inside a live region (`btn.closest('[aria-live]')` returns `null`). The swap handler exchanges the two input values and their `dataset.stationId` and sets nothing else — no status, no announcement.
**Impact:** WCAG 4.1.3 Status Messages (Level AA). Both actions complete invisibly for screen reader users. Swap is the worse of the two: the user cannot tell whether the exchange happened without navigating back through both fields.
**Fix:** Route both through the `#status` region that already exists with `role="status" aria-live="polite"` (`index.html:178`): `setStatus('Link copied.')` and `setStatus(\`Swapped — now ${to} to ${from}.\`)`.

---

### F10 · Two controls mean "no changes", and one silently overrides the other — Major

**Where:** `index.html:96-108` (`#max-changes`, whose first real option is "Direct only") and `index.html:121-124` (`#direct-only`, "Direct connections only") — both inside the same "More options" panel, visible simultaneously
**Observed:** At `js/app.js:685-688` the checkbox filter runs first (`base.filter(j => j.transfers === 0)`), then the select's (`j.transfers <= maxChanges`). With the box ticked, the select has no effect regardless of its value, and nothing on screen says so. The zero-result copy at `:691-693` names only the checkbox — so a user who used the select gets the generic message described in F2.
**Impact:** Users see two ways to express one intent, can't tell which is authoritative, and get recovery advice that's correct for only one of them. Nielsen #4, consistency and standards.
**Fix:** Delete `#direct-only` — "Direct only" is already the `value="0"` option of Max changes. Then F3's fix covers serialisation, and F2's message can name the single remaining control. Keep reading the legacy `direct=1` URL param and map it onto `#max-changes = "0"` so existing shared links keep working.
**Evidence:** screenshot at 768px, both controls visible in the same panel

---

### F11 · Developer telemetry in user-facing status text — Minor

**Where:** the status line after every search
**Observed:** "…already take the earliest onward trains. **(6 timetable queries)**". Across identical or near-identical searches I saw 5, 6, 7, 10 and 13.
**Impact:** The number means nothing to a traveller, and its variance between runs of the same search reads like the app is behaving inconsistently.
**Fix:** Remove it, or gate it behind a `?debug=1` flag.

---

### F12 · "Press ⌘C to copy" shown to non-Mac users — Minor

**Where:** `js/app.js:967`
**Observed:** The clipboard-denied fallback sets the button text to `'Press ⌘C to copy'` unconditionally.
**Impact:** Windows and Linux users are given a keystroke that does not exist on their keyboard, in the exact moment the automatic path has already failed.
**Fix:** `navigator.platform`/UA-CH check for the modifier, or drop the shortcut: "Link selected — copy it now."

---

### F13 · The hurry scale mixes pace words with the product name — Minor

**Where:** `js/app.js:14-20`, tick labels at `index.html:135-137`
**Observed:** The five steps are Normal (official timings) / Quick (4 min) / Brisk (3) / Sprint (2) / **ZIPPIN** (0). Four are adverbs of pace on one axis; the fifth is the brand. It is also the only step that skips a value — there is no 1-minute setting.
**Impact:** A first-time user cannot rank "ZIPPIN" against "Sprint" without moving the slider and reading the minute count. The label carries no information about what it does.
**Fix:** Put the top step on the same axis — "Reckless — 0 min changes" or "Doors closing — 0 min" — and let the ⚠️ warning carry the brand association. Consider adding the missing 1-minute step.

---

### F14 · "Time" and "Departure" label adjacent fields, only one of which is a time — Minor

**Where:** `index.html:54-58` (`#timemode`, labelled "Time") and `:65-66` (`#time`, labelled "Departure", relabelled to "Arrival" by `app.js:997`)
**Observed:** The field labelled "Time" is a depart/arrive mode select and contains no time. The field immediately to its right, labelled "Departure", is the actual clock.
**Impact:** The more prominent, left-most label is the one that doesn't do what it says. Users scanning for where to set the time hit "Time" first.
**Fix:** Rename the select to "Depart / arrive".

---

### F15 · Three label styles for one action, none of which say they leave the site — Minor

**Where:** `js/app.js:299` ("Check price on SBB · 18:34 → 19:00"), `:310` ("Compare: one ticket for the whole trip · 18:34 → 20:56"), `:295-300` rendered as bare chips reading "Lausanne → Yverdon-les-Bains · 18:34"; plus the footer link at `index.html:187`
**Observed:** All four are `target="_blank" rel="noopener"` links to `www.sbb.ch`, and none carries a new-tab or external indication in text, title, or accessible name. The third form doesn't mention SBB at all. Visually the purple chip is nearly the same treatment as the `.badge.night` "Shorter ticket" pill in the result rows — which is **not** interactive.
**Impact:** The same pill shape means two different things (inert badge vs. offsite navigation), and the highest-intent action on the page — going to buy a ticket — gives no warning that it opens a new tab on a third-party site.
**Fix:** One consistent pattern: "Price on SBB — Lausanne → Yverdon-les-Bains, 18:34 ↗", with `aria-label` ending "(opens sbb.ch in a new tab)". Differentiate the interactive pill from the inert badge (border, or the ↗ marker).

---

### F16 · Footer fine print runs ~140 characters per line — Minor

**Where:** `p.fine`, `index.html:190-194`; width from `.wrap { width: min(880px, 100% - 2rem) }` (`styles.css:50`)
**Observed:** measured 880px wide at ~12.5px, giving roughly 140 characters per line at 1440.
**Impact:** Roughly 55% over the ~90-character comfortable maximum; the eye loses its place on return sweeps. It's the legal/disclaimer text, so low stakes.
**Fix:** `max-width: 62ch` on `.fine` and `.help`.

---

### F17 · 22px tap targets on the transport-mode filters — Minor

**Where:** `index.html:114-118`, `label.inline-check` inside `fieldset.modes`
**Observed:** At 390px the five labels measure 55–91 × **22px**, four on one row and "Cable car" wrapping to a second, rows 29px apart centre-to-centre.
**Impact:** Below WCAG 2.5.8's 24×24 minimum, though it **passes via the spacing exception** — 24px circles centred on adjacent targets don't intersect (29px vertical, >55px horizontal). So not a violation, but 22px is still thumb-hostile in practice.
**Fix:** `padding-block: .25rem` on `.inline-check` clears 24px with no layout change.

---

### F18 · Selects and links use a different focus ring from everything else — Polish

**Where:** `styles.css:114` — the rule covers `input`, `button`, `summary` only
**Observed:** `#timemode`, `#limit`, `#max-changes` and the anchors fall through to Chrome's default `1px auto rgb(0, 95, 204)` blue ring, while every other control gets the 2px `--accent` ring. Both are clearly visible; they just don't match.
**Fix:** Add `select:focus-visible, a:focus-visible` to the existing rule.

---

## By theme

**Accessibility** — F4, F8, F9 are the substantive ones and all three sit on the primary path: picking a station, reading a result, sharing it. F5 and F6 are dark-mode-only and disappear entirely in light mode. Nothing here is structural — the markup uses real labels, a real `<fieldset legend>`, a real live region, and `<details>` for disclosure; the gaps are in the dynamically-built parts (`app.js`) rather than `index.html`.

**Unexpected behavior** — F7 (blank space toggles Night GA) and F10 (checkbox silently overrides select) are the two places where a control did something other than what its label and position promised. F1 is the inverse: a control that correctly did nothing, in a UI that didn't say so.

**Naming and terminology** — F10, F13, F14, F15. The label inventory across the page is small and mostly clean — no same-label-different-destination and no same-destination-different-label collisions — but four labels can't be predicted before use: "ZIPPIN" as a speed, "Time" for a mode select, "Results" for a fetch count, and a bare station-pair chip that turns out to be an offsite link.

**Forms and error handling** — F2 is the whole story. Required-field validation is native and correct (submitting empty moves focus to `#from` with "Please fill out this field"), but every *application*-level failure funnels into one undifferentiated grey sentence that guesses at a cause.

**Performance** — Nothing to fix. 142 DOM nodes, 5 requests, 31 KB transferred, no render-blocking scripts, DOMContentLoaded at 1.18s. The multi-second waits during a search are the timetable API (10–13 sequential queries at high hurry factors), and the spinner + disabled Search button communicate that correctly.

---

## Subjective notes

A reasonable designer could disagree with all of these.

- The dark theme is the better-looking of the two and the light theme is the more accessible one. Worth deciding which is the reference and bringing the other up to it, rather than treating dark as a filter over light.
- The backronym tagline — "ama**Z**e speed**I**er chea**P**er tri**P**s **I**n switzerla**N**d" — is charming once you get it, but the bolded mid-word capitals read as typos on first glance, and "speedIer cheaPer" scans as broken text before it scans as an acronym. It's the second thing on the page.
- The "3 ways to shorten your ticket" panel is the strongest piece of design here: it ranks the options, shows the cost of each in km, and says outright that it can't see fares. If anything deserves to be more prominent than the hurry slider, it's this.
- Search results appear ~250px below the fold at 1440 with no scroll or focus move after submit. Not a violation — the live region announces it — but the eye has nothing to follow.

---

## Not covered

- **The "hidden connection" result UI — the app's headline feature.** Across four route/time combinations at maximum hurry factor (Lausanne → Zürich HB, → Interlaken Ost, → Zermatt, and a Night GA run), every search returned *"No hidden connections on this route"*. I never saw a speedy-labelled result row, the tight-change feasibility notes (`app.js:23-26`), or the miss-recovery text rendered, so none of that is audited.
- **Rate-limit retry status** (`app.js:1014`) — never triggered.
- **Network and API error states** (`app.js:852`, `.status.error`) — never triggered. I confirmed the error class exists and which paths use it, but not how it looks.
- **The actual clipboard write.** `navigator.clipboard.writeText` never settled under automation, so F9 and F12 are based on reading `copyLink` (`app.js:961-975`) rather than observing the button change.
- **Real assistive technology.** All accessibility findings come from the accessibility tree, computed styles and source. No VoiceOver or NVDA pass was run.
- **Real touch input.** Mobile findings are from a 390px viewport in a desktop browser, not a device.
- **`zippin.html`**, the self-contained bundle produced by `build.py`. Only the hosted module version was audited; the bundler inlines the same CSS and JS, so findings should carry over unchanged.
