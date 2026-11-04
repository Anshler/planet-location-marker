# UI redesign: a calm skeleton

Status: **approved spec**, ready to implement in four chunks (§13). Branch `p7/redesign`, base `40131ce`. Chunks 1 and 2 are implemented; their deviations are in §15.

The owner asked for this: "We've added quite a bit so the UI is getting quite dense and complex. Complex is fine but it has to be intuitive — see if we can improve that."

This spec is the judged synthesis of two audits and three proposals. The working files are in the session scratchpad: `audit-desktop.md` (P1–P16), `audit-mobile-a11y.md` (M1–M15, A1–A5), `design-disclosure.md` (A), `design-tasks.md` (B) and `design-canvas.md` (C). Problem ids below (P3, M5, A2…) refer to those audits.

---

## 0. The design in one page

The skeleton does not change: a right panel on desktop, a bottom sheet on phones, the time bar, the view toolbar and the 3D view. Each surface gets one clear primary layer. Everything else is one labelled step away, and nothing is hidden by width.

| # | Move | Fixes |
|---|---|---|
| 1 | **A stable toolbar of four labelled controls**, the same in every view: `[Globe \| Sky \| Map] [Tools ▾] [Share ▾] [⋯]`. Only the contents of Tools follow the view. | P2, P4, P11, P14, P15, M4, M6 |
| 2 | **Modes show as chips, and Esc leaves them in order.** One status stack, top centre, holds a chip for each mode with its own Exit: viewpoint, map, telescope, following, ruler, phone pointing, exposure, loop, pick. Esc exits the newest chip before it deselects. The shortcut flash joins the stack, so it can no longer cover a chip. | P5, P6, P13 |
| 3 | **One Time popover**, opened from the date button. It holds go-to, step size, direction, loop, time zone, 24-hour clock and a legend for the time bar. The bar keeps transport, date, speed and Now. | P3, P7, P11, P12, P15, M6 |
| 4 | **Five tabs re-cut by intent:** Up now · Details · Events · Explore · Display. Tours and history leave Events for Explore. Layers, Sky conditions and the remaining settings become Display. About folds into Display. | P1, P4, P7, P8, M3 |
| 5 | **Phone: a bottom tab bar that is always visible, and a short sheet head.** The body strip and the time-bar tools row are deleted. Selecting a world from the view raises the sheet to Details. | M1, M2, M5, M12 |
| 6 | **Search finds the sky too:** places, plus planets, named stars, deep-sky objects, comets, guest stars, spacecraft and satellites. | P15 |
| 7 | **One visual system:** 5 type sizes, 3 weights, 5 spacing steps, 4 radii, a chip and a badge, one help-text class, eyebrows for group titles only, no cards inside cards, and selected states that never rely on colour alone. | M7, M8, A4 |

**Bytes:** estimated at about −9 KB raw net (realistic range −12 to +4 KB). We plan against a target of ≤ −3 KB to absorb estimate error, and the hard ceiling is +15 KB (§11).

---

## 1. Why this design (judging and scores)

Each proposal was scored from 1 to 10 against both audits, the screenshots, its mock-ups and the code (`js/ui/shell.js`, `index.js`, `dom.js`, `view-switch.js`, `timebar.js`, `css/app.css`). For risk and bytes, higher means safer or smaller.

| Criterion | A: disclosure | B: tasks | C: canvas |
|---|---:|---:|---:|
| Intuitive for a first-time user | 7 | 8 | 8 |
| Power-user efficiency (keys, density) | 8 | 9 | 6 |
| Discoverability of the Phase 5–7 features | 7 | 9 | 8 |
| Phone ergonomics | 7 | 8 | 9 |
| Accessibility | 8 | 8 | 7 |
| Consistency | 8 | 8 | 8 |
| Implementation risk in this codebase | 8 | 5 | 4 |
| Byte budget | 9 (−4 KB) | 6 (+8 KB) | 8 (+3 KB) |
| **Total** | **62** | **61** | **58** |

**Why A is the base.** It keeps the skeleton, so most of the work is moving DOM and deleting duplicates. Its line references match the code; C's are off by about 120 lines (it cites `MOBILE_QUERY` at `shell.js:166`, but it is at `:46`). A also measured its toolbar and phone head in mock-ups, and it is the only proposal that comes out net negative in bytes.

**Taken from B and C:**
- Map as a third view segment, so the view control always shows a selection (B, C).
- One Tools menu whose contents follow the view, instead of A's separate Camera and Tools menus (B, C).
- The long-exposure presets as items inside Tools, which deletes the expose popover (C).
- A real bottom tab bar on phones (B, C).
- The time zone shown inside the date button instead of a separate chip (B, C).
- Settings merged with Layers into Display (C).
- Raising the phone sheet when a world is selected from the view (B).
- The exposure Esc guard, "Reset layers", the "Up now" name and the "Search for a star, comet or spacecraft" entry in Details (B).
- A one-time "what moved" toast for returning users (C).

**Rejected, with reasons:**
- **B's command palette** (`commands.js` plus Features and Events sections). It costs about 9 KB and adds about 60 new strings just before the Vietnamese sweep, and the stable toolbar and Explore already give each feature a visible home. Search stays places plus the sky.
- **B's Settings as a modal dialog.** It is one more modal shell, and it hides settings from text mode. The settings that remain fit at the end of Display.
- **B moving Path and footprint out of Layers.** The T and O switches would have no home while nothing is selected.
- **B moving the vantage points to Explore.** They are camera states, so they belong in Tools.
- **C's master–detail Tonight page and selection bar.** They add about 4.5 KB, new routing (`ui.page`), actions re-parented between hosts, priority-overflow measuring, and a bar covering the bottom-left of the canvas. Most of the benefit comes far more cheaply from raising the sheet on selection and putting the Details action row first.
- **C's breakpoint change** (`MOBILE_QUERY` to 760 px for any pointer) and moving the dock to the top row. Both are layout churn with real-device risk. The tablet problem is solved by capping the sheet's width instead.
- **C's Display search box with "elsewhere" rows.** Bytes and strings, for a tab that now fits in about 1.5 screens.
- **A's layer presets** (Simple/Standard/Guides/Everything/Custom plus a `layerCustom` pref). It is a new concept at +2.6 KB. Grouping by view plus "Reset layers" answers P8 more cheaply.
- **A's Camera menu**, merged into Tools, and **A's `uiOpen` pref** for persisted group states. Groups open by rule instead.

---

## 2. Rules every surface follows

- **R1 One home per control.** A control lives where it acts. Elsewhere there is at most a *link* to it (a row or button that opens or scrolls to the owner), never a second copy of its state.
  - Documented exceptions: the Path and "Where it's up" switches appear in both Display and Details (same label, same switch); the Sun-paths switch appears in both Display and the Sun's card; Night vision appears in Display and in ⋯ (outdoor use).
- **R2 Narrow widths may hide a label, never a control.** Every control that moves out of a bar has a home in a menu or a popover.
- **R3 A mode you enter shows a chip with an Exit,** and Esc leaves the newest one first.
- **R4 Words, not glyphs.** Icon-only buttons are allowed only for universal glyphs: play/pause, ⋯, ×, chevrons, and the calendar inside a labelled row. Those always carry an `aria-label` and a tooltip. Phone floating buttons carry a caption under the icon.
- **R5 Say a thing once per screen.** "What's up", sunset and sunrise, the constellation and the tonight verdict each appear once.
- **R6 Plain words first, the term second:** "Totality begins (C2)", "City sky: stars to magnitude 3.6 (Bortle 9)", "Sidereal day (23 h 56 min)". Explanations live in visible ⓘ disclosures, never only in `title=`.
- **R7 Whole phrases.** Every user-visible string is one phrase with `{placeholders}`, filled by `tpl()` (§8.1) or a template literal around a complete sentence. Nothing is concatenated from fragments, so the Vietnamese sweep can translate every string as it stands.

---

## 3. Information architecture

### 3.1 Where everything lives

```
Top bar ─────── wordmark · location chip = Search (places and the sky; / and Ctrl+K) · Back to Earth (on Mars)
Status stack ── one chip per active mode, oldest first, then the shortcut flash
Toolbar ─────── [Globe | Sky | Map] [Tools ▾] [Share ▾] [⋯]
                Tools (globe): Look from: Near the Earth / The L1 point / Earthrise / The whole solar system ·
                               Turn with the Earth (L) · Reset the view (Home) · Sky view tools…
                Tools (map):   Reset the view (Home) · Sky view tools…
                Tools (sky):   Follow: Look around freely / Follow {name} / Follow the stars (K) · Telescope on {name} ·
                               Angle ruler (A) · Point the phone at the sky · Long exposure: Star trails / Analemma / Free ·
                               Reset the view (Home)
                Share:         Share link (S) · Postcard… · Time-lapse video…
                ⋯:             Keyboard shortcuts and mouse (?) · Interface tips · Night vision (Shift+N) ·
                               Hide the interface (H) · Fullscreen (F) · Install the app · About, credits and help
Time bar ────── [|◀ 1 h] (▶) [1 h ▶|] · [date · time · zone ▾] · [⚠] · [− speed +] · [LIVE / Return to now] · scrubber
                Time popover: Go to · Stepping · Loop · Show times in · 24-hour clock · What the time bar shows
Panel tabs ──── Up now · Details · Events · Explore · Display
Situational ─── Eclipse Companion HUD · tour lower third · toasts · coach tips · intro caption · Show interface
Dialogs ─────── Search · Help · Postcard · Time-lapse video · Share-link fallback · Coach tip
```

### 3.2 Desktop (≥ 900 px, or coarse and ≥ 1100 px; `MOBILE_QUERY` unchanged)

```
┌──────────────────────────────────────────────────────────────────────┬─────────────────────────────────┐
│ [◉ Planet Location Marker] [📍 Royal Observatory Greenwich, UK · 51.48° N 0.00° E  ⌕]  │ Up now  Details  Events  Explore │
│                                                                      │ Display                       ⇥ │
│            ┌ status stack ─────────────────────────────────┐         ├─────────────────────────────────┤
│            │ ◉ Telescope on Jupiter · 0.8° field   [Leave Esc]│        │                                 │
│            │ ⦿ Long exposure: Star trails · 120 frames [Save image] [Stop] │                          │
│            │              Constellation lines off (flash)  │         │   active tab content (scrolls)  │
│ ┌ Eclipse HUD ┐└───────────────────────────────────────────┘         │                                 │
│ └─────────────┘                3D view                               │                                 │
│                                                                      │                                 │
│             [ ◍ Globe | ✦ Sky | ▦ Map ] [ ⚙ Tools ▾ ] [ ⇪ Share ▾ ] [ ⋯ ]                          │
│ ┌──────────────────────────────── time bar ─────────────────────────────────┐ │                       │
│ │ [|◀ 1 h] (▶) [1 h ▶|]  📅 Sat 6 Feb 2027 · 20:00:00 · Greenwich, UTC+0 ▾  [− Real time +] [● LIVE] │  │
│ │ ═════════════════════════════════════●═══════════════════════════════════ │ │                       │
│ └───────────────────────────────────────────────────────────────────────────┘ │                       │
└──────────────────────────────────────────────────────────────────────┴─────────────────────────────────┘
```

- The toolbar keeps today's place, above the time bar's right end. It is about 520 px wide and fits the 852 px canvas at 1280×720 (A's mock, `shots/da-d1280-mock-toolbar.png`).
  - Under a 560 px `viewbar` container, the labels of Tools and Share hide. Globe, Sky and Map keep their labels down to 420 px.
- The panel tabs are text labels, as today. Five fit in 380 px.
- **The rail** (collapsed panel) becomes 64 px wide, with each tab's icon over an 11 px label. Today it shows six bare icons.
- **Tab icons:**

  | Tab | Icon |
  |---|---|
  | Up now | `star` |
  | Details | `target` |
  | Events | `events` |
  | Explore | `history` |
  | Display | `layers` |

  The Sky view keeps `sky`, which ends the Sky/Sky icon clash (P4).

### 3.3 Phone (mobile layout)

```
PEEK                                   HALF                                   FULL
┌────────────────────────────────┐     ┌────────────────────────────────┐     ┌────────────────────────────────┐
│[📍 Greenwich, United Ki…     ⌕]│     │[📍 Greenwich, United Ki…     ⌕]│     │[📍 Greenwich, United Ki…     ⌕]│
│(status chips, max 2)   ┌─────┐ │     │(status chips)          ┌─────┐ │     │┌──────────────────────────────┐│
│                        │ ◍   │ │     │                        │ ◍   │ │     ││            ▬▬▬               ││
│                        │Globe│ │     │                        │Globe│ │     ││(▶) 20:00:00 ▾    [− 1× +][Now]││
│                        │ ✦   │ │     │       globe            │ ✦   │ │     ││    Sat 6 Feb 2027 · UTC+0    ││
│                        │ Sky │ │     │                        │ Sky │ │     ││══════════●══════════════════ ││
│                        │ ▦   │ │     │                        │ ▦   │ │     │├──────────────────────────────┤│
│       globe            │ Map │ │     │                        │ Map │ │     ││ Night · Fully dark 18:52–05:35│
│                        ├─────┤ │     │                        └─────┘ │     ││ Sunset 16:58 · Sunrise 07:28 ││
│                        │ ⚙   │ │     │┌──────────────────────────────┐│     ││ ABOVE THE HORIZON · 5         ││
│                        │Tools│ │     ││            ▬▬▬               ││     ││ ◔ ● Uranus     56° SSW  ∿    ││
│                        │ ⇪   │ │     ││(▶) 20:00:00 ▾    [− 1× +][Now]││     ││ ◔ ● Jupiter    25° E    ∿    ││
│                        │Share│ │     ││    Sat 6 Feb 2027 · UTC+0    ││     ││ …                            ││
│                        │ ⋯   │ │     ││══════════●══════════════════ ││     ││ BELOW THE HORIZON · 4         ││
│                        │More │ │     │├──────────────────────────────┤│     ││ …                            ││
│                        └─────┘ │     ││ Night · Fully dark 18:52–05:35││     ││ ▸ Charts · Sky dome           ││
│┌──────────────────────────────┐│     ││ ABOVE THE HORIZON · 5         ││     │└──────────────────────────────┘│
││            ▬▬▬               ││     ││ ◔ ● Uranus     56° SSW  ∿    ││     │                                │
││(▶) 20:00:00 ▾    [− 1× +][Now]││     ││ ◔ ● Jupiter    25° E    ∿    ││     │                                │
││    Sat 6 Feb 2027 · UTC+0    ││     ││ ◔ ● Saturn     17° WSW  ∿    ││     │                                │
││══════════●══════════════════ ││     │└──────────────────────────────┘│     │                                │
│└──────────────────────────────┘│     │                                │     │                                │
│ ★      ◎       ☆      ↺      ≋ │     │ ★      ◎       ☆      ↺      ≋ │     │ ★      ◎       ☆      ↺      ≋ │
│Up now Details Events Explore Display│Up now Details Events Explore Display│Up now Details Events Explore Display│
└────────────────────────────────┘     └────────────────────────────────┘     └────────────────────────────────┘
```

**Bottom tab bar.** On `applyLayout('mobile')` the one `tablist` node moves into a new `nav.navbar`, a sibling placed after `.sheet`. Its background is solid `--surface-solid` (fixes M12b).
- Each tab is a 20 px icon over an 11 px/600 label, at least 64×56 px. The bar is 56 px plus `--safe-b`.
- The keyboard is unchanged: one roving WAI-ARIA tablist.

**Sheet.** The head holds only the handle (a 44 px hit area over a 4×40 grip) and the time bar. N is the nav height, H is handle plus time bar (about 100 px).

| Snap | Height (390×664) | Content | Globe visible |
|---|---|---|---|
| peek | H ≈ 100, plus the nav 56 | 0 (tabs visible in the nav) | 54 → 508 px |
| half | clamp(round((vh − N) × 0.5), H + 120, full) ≈ 304 | ≈ 204 px (today ≈ 88) | 54 → 304 px |
| full | vh − N − 56 ≈ 552 | ≈ 452 px (today 409) | 0 |

- **Tapping a tab** at peek raises the sheet to half on that tab. Above peek it switches tab and keeps the height.
- **Selection from the view raises the sheet** (fixes M2). If the panel store write's `source` is `'labels'` or `'click'` (the four `panel: 'details'` writes in `js/main.js:1706, :1901, :1936, :2034`), the layout is mobile and the snap is peek, the shell raises the sheet to half. A sky result chosen in Search does the same, through `ui.openPanel('details', {sheet: 'half'})`. Selections made by Events Jump, Moments links and tours do not raise it.
- **Floating column** (right, under the top bar):
  - the view segment as three stacked 44×48 buttons with captions;
  - Tools, Share and ⋯ as 52×52 buttons with captions;
  - every button `flex-shrink: 0`, which fixes the 36×18 squash (M4).

  Above peek only the view segment shows; at full the column hides.
- **Status stack on phone:** top-left under the top bar, `right: 76px`. It shows at most 2 chips; the rest collapse into a "+{n} more" chip that expands them.
- **Eclipse HUD on phone:** collapses itself to its existing one-line state while the sheet is above peek or the view is Sky (M10). A user's own expand holds until the eclipse ends.

**Tablets.**
- **Portrait** (coarse, mobile layout, ≥ 600 px wide): `.sheet` and `.navbar` become `width: min(560px, 100% − 32px); left: 16px` with all corners rounded. The globe stays visible to the right, and switches sit next to their labels (M9).
- **Landscape** (desktop layout, coarse): every control gets the coarse 44 px tokens (§9.1).

### 3.4 Text mode (no WebGL)

One readable column, in this order: banner, top bar, time bar, Eclipse HUD (inline), toolbar, tabs.

- **Toolbar:** only `[Share ▾] [⋯]`. Share offers Share link and Postcard. ⋯ offers Keyboard shortcuts and mouse, Night vision and About, credits and help.
- **Up now:** the Charts card is open on the Sky dome, as today. The tip drops the "V for Sky view" sentence.
- **Explore:** hides Guided tours and Stand on Mars, because `startTour` returns false without 3D (`js/app/actions.js:1615`).
- **Display:** shows only Sky conditions, Comfort, About and the App row, with the note "Layers are drawn in the 3D view, which this device can't show."
- **Not mounted:** Tools, the status stack (except the flash), view switch and Quality.

### 3.5 Tabs, old → new

| Old tab (`id`) | New tab (`id`) | What changes |
|---|---|---|
| Sky (`sky`) | **Up now** (`sky`) | New name and icon. The list comes first; the dome and Tonight merge into one Charts card after it. |
| Details (`details`) | Details (`details`) | Action row first; facts before the extras; toggles become switches. |
| Events (`events`) | Events (`events`) | The calendar only, showing about 8 weeks plus "Show the rest". |
| — | **Explore** (`explore`) | Tours, The sky you were born under, Moments in history, Famous comets, Two places at once, Stand on Mars. |
| Layers (`layers`) | **Display** (`display`) | Layers grouped by the current view, plus Sky conditions, Quality, Comfort, About and App. |
| Settings (`settings`) | → Display / Time popover / Tools / ⋯ | See §7. |
| About (`about`) | → Display › About this app | Collapsible; ⋯ › About, credits and help opens it. |

The id `sky` stays, so `#tp-sky`, `.tabpanel--sky`, the skip link and the coach target all keep working.

---

## 4. Components

### 4.1 Top bar and Search

- **Delete the separate search button** (`topbar.js:49-52`). The location chip *is* the search.
  - It gets a trailing ⌕ glyph and, on fine pointers, a `/` kbd hint.
  - Accessible name: `'Location: {place}. Search places and the sky'`.
- **Brand gradient id:** `brandMark()` uses `uid('pc-brand')` instead of the constant `pc-brand-earth` (`topbar.js:22`; fixes A3).
- **Palette, new "In the sky" section.** It sits above Places once the query has ≥ 2 characters.
  - **Index**, built lazily on first open: `BODIES`, host-aware through `hostBodies`, plus every `ctx.extras.ids()` with `ctx.extras.meta(id).name` and `kindLabel` (stars, DSOs, comets, guest stars, spacecraft, satellites, and the moons on Mars). It is rebuilt when the registry refreshes, because star names arrive late.
  - **Matching:** prefix, then word prefix, then substring, folded with the existing `fold()`. The nine bodies rank before extras. At most 6 rows.
  - **Row:** name, plus `'{kind} · {alt}° up in the {direction}'` or `'{kind} · below the horizon'`.
  - **Enter or click:** `ui.act('select', id, {fly: true})`, close the palette, then `ui.openPanel('details', {sheet: 'half'})`.
  - It uses the same `role=option` listbox, so arrows and Enter already work.
  - Placeholder: "Search a place, or a planet, star or comet". Empty-state hint: "Try Tokyo, Jupiter, Sirius, ISS or Halley."
- **Esc always closes the palette** in one press. Delete the clear-on-first-Esc branch (`location.js:484-486`); the × button clears the text (fixes P6).
- **One offline message.** When online search is unavailable, show only the footer status. Drop the "Online results" heading and the paragraph.
- **Footer:** "Use my location" and "Pick on the globe" stay. "Compare with…" and "Stand on Mars…" leave the footer for Explore and Details › More. The palette's `'compare'` and `'mars'` modes are unchanged.

### 4.2 Toolbar (`view-switch.js`, rewritten to about half its size)

```
[ ◍ Globe | ✦ Sky | ▦ Map ]   [ ⚙ Tools ▾ ]   [ ⇪ Share ▾ ]   [ ⋯ ]
  radiogroup "View"             menu button     menu button     menu button "More"
```

- **Role:** `div.viewbar[role=group][aria-label="View controls"]`. Today it claims `role=toolbar` without arrow-key roving, so `group` is the honest role. Tab moves between its four controls.
- **View segment** (`.seg.seg--view`, radiogroup "View"):

  | Segment | Icon | `data-mode` | Keys |
  |---|---|---|---|
  | Globe | `globe` | `orbit` | V |
  | Sky | `sky` | `sky` | V |
  | Map | `map` | `map` | M |

  - Arrow keys move through all three and select.
  - **Globe stays checked** during L1, Earthrise and the solar system: they are ways of looking at the globe. Clicking Globe there returns to the close view (today's `setMode`). The control therefore always shows a selection (P4).
- **Tools ▾** (`.vb-tools`, new icon `tools`, a two-slider glyph of about 150 bytes; `lock` and `unlock` are deleted).
  - Its accessible name follows the view: "Tools for the globe", "Tools for the map", "Tools for the Sky view". The visible label stays "Tools".
  - While any tool state is non-default (vantage, system, follow, telescope, ruler, aim, exposure), the button gets `.is-on` plus a 6 px dot. The dot is a shape cue, not only colour.
- **Share ▾** (`.vb-share`): now `role=menu`, no longer `role=dialog` (P11, A2).
- **⋯** (`.vb-more`, `aria-label="More"`): shown on every layout. The `.ui:not([data-layout="mobile"]) .vb-more { display:none }` rule is deleted.
- **Deleted buttons:** `.vb-lock`, `.vb-vantage`, `.vb-track`, `.vb-expose`, `.vb-fs`, `.vb-help`, and the ruler and point buttons from `sky-tools.js`. `.vcap` goes as well. The pill logic stays and moves into mode chips (§4.4).

### 4.3 Menus: one builder

New `menu({button, label, items, placement})` in `js/ui/dom.js` returns `{open, close, destroy}`. It replaces the three hand-written builders: `mountMoreMenu` (`view-switch.js:55-110`), the vantage menu (`:150-185`) and the share popover (`:341-366`). It also replaces the expose popover (`expose.js:56-71`).

**Items.** Each item is `{id, kind: 'item'|'radio'|'check', icon, name, detail?, kbd?, group?, hidden?(), disabled?(), disabledText?, checked?(), run()}`.

- Items sharing a `group` render inside `div[role=group][aria-label]`, with a visible eyebrow title. A `role=separator` sits between groups.
- The DOM is rebuilt from `items` on every open, so state is always fresh and nothing subscribes to the store.

**Row.** The `.vmenu__item` pattern the audit praised (M15), plus:
- a leading ● for a checked radio and ✓ for a checked checkbox (non-colour cue, A4);
- a right-aligned `.vmenu__kbd` hint on fine pointers (A5);
- for disabled items, `aria-disabled="true"`; they stay focusable and `disabledText` replaces the detail line.

**Keyboard:**
- Opening focuses the checked radio, else the first enabled item.
- ↑/↓ wrap; Home and End jump to the ends.
- Enter and Space run the item and close the menu.
- Esc closes and returns focus to the button (`openPopover`).
- Tab closes and lets focus move on. A pointerdown outside closes.
- An item that opens a dialog (Postcard…, Time-lapse video…) hands focus to the dialog; on close, focus returns to the menu button.

**Tools, globe view** (including L1, Earthrise and the solar system):
```
LOOK FROM
 ● Near the Earth              Orbit the globe from close by
 ○ The L1 point                The sunlit Earth from 1.5 million km, as NASA’s DSCOVR sees it
 ○ Earthrise                   The Earth rising over the Moon’s limb, from lunar orbit
 ○ The whole solar system      Zoom out until the beams become lines across the solar system
──────────
 ✓ Turn with the Earth     L   Your place stays in view as the Earth turns
   Reset the view       Home   Back to the starting framing
──────────
   Sky view tools…             Follow, telescope, angle ruler and long exposure
```

**Tools, map view:**
```
   Reset the view       Home   Back to the starting framing
   Sky view tools…             Follow, telescope, angle ruler and long exposure
```

**Tools, Sky view:**
```
FOLLOW                                                                  
 ● Look around freely      K   The view stays where you point it
 ○ Follow {name}           K   Keep it centred as time runs          (disabled: "Select something first")
 ○ Follow the stars        K   Turn with the sky, as a tracking mount does
 ✓ Telescope on {name}         Its true size and orientation, followed   (disabled: "Select something first")
MEASURE AND POINT
   Angle ruler             A   Tap two things to measure the angle between them
   Point the phone at the sky  The view follows your phone           (only where canPointAtSky())
LONG EXPOSURE (ONE IMAGE)
   Star trails                 Tonight from dusk at 10 min/s, facing the celestial pole
   Analemma                    The Sun at noon every day for a year: its figure-8
   Free exposure               Stack whatever you do with the time and the view
   (while an exposure runs, this group holds one item: "Stop the exposure")
──────────
   Reset the view       Home   Back to the starting framing
```

How the Tools items behave:
- "Sky view tools…" calls `setViewMode('sky')` and reopens Tools on the next frame, so the sky instruments are one step away from every view.
- The long-exposure names and details come from `EXPOSE_PRESETS` (`expose.js:15-18`). Choosing one calls `actions.expose(id)`, as the popover does today.
- Items unavailable on Mars, without WebGL or without sensors are hidden, using today's conditions (`view-switch.js:226-254`, `body-card.js:251-256`).

| Item | Action (all exist today unless marked new) |
|---|---|
| Look from | `setVantage('l1'\|'moon'\|'none')`, `setSystem(bool)` |
| Turn with the Earth | `setEarthLock(bool)` |
| Follow | `setTracking('none'\|'body'\|'stars')` |
| Telescope | `telescope(id)` / `leaveTelescope()` (**new**, §4.4) |
| Angle ruler / Point | `setRuler(bool)` / `pointAtSky(bool)` |
| Long exposure | `expose(kind)` / `expose(null)` |
| Reset the view | `resetCamera()` |

**Share:**
```
   Share link              S   Opens exactly this view: place, time, camera and layers
   Postcard…                   A designed image of this view, ready to post
   Time-lapse video…           A clip of a day here, a night of turning stars or the 2027 eclipse   (hidden without WebGL)
```
- The system share sheet still runs inside the click, which keeps the user activation (`view-switch.js:364`).
- The video dialog's preset "Star trails" is renamed **"A night of turning stars"**, so it no longer clashes with Long exposure › Star trails (P4).

**⋯ More** (every layout):
```
   Keyboard shortcuts and mouse   ?    The keys, and what the mouse does   (coarse: "Gestures and help")
   Interface tips                      The three tips from the first visit, again    (hidden in text mode)
 ✓ Night vision              Shift+N   A dim red screen for dark-adapted eyes, kept awake   (on: "On: choose again for full colour")
   Hide the interface            H     Just the view; move the pointer or tap Show interface to return   (hidden in text mode)
 ✓ Fullscreen                    F     Use the whole screen   (hidden when unsupported)
   Install the app                     Open it like an app, offline too   (only when installOffer() says so)
   About, credits and help             Version, accuracy, credits, privacy, report a problem
```
"About, credits and help" calls `ui.openPanel('display', {reveal: 'about'})`, which opens the About group, scrolls it into view and focuses its summary.

### 4.4 Status stack and mode chips (`js/ui/modes.js`, new, about 2 KB)

`mountModes(host, ctx)` is exposed as `ui.modes` with this API:

```js
ui.modes.set(id, { icon, title, detail, actions: [{label, run}], exit: {label, run} }); // add or update; first set gets seq = ++n
ui.modes.update(id, { detail });   // text only (setText), for the 4 Hz readouts
ui.modes.clear(id);
ui.modes.top();                    // newest id or null
ui.modes.exitTop();                // runs the newest chip's exit; returns true if one ran
ui.modes.flash(text);              // transient 1.2 s entry after the chips; aria-hidden (the announcer speaks)
```

- **Placement.** One container, `div.status-stack[role=region][aria-label="Active modes"]`. The shell appends it right after the top bar, so its chips come after the location chip in the Tab order.
  - Desktop: top centre of the canvas, `top: calc(64px + var(--safe-t) + var(--ecl-h, 0px))`.
  - Phone: see §3.3.
  - Cinema hides it.
- **Order.** Chips appear in activation order, oldest first. The flash is always the last child, so it can never cover a chip (P13). On fine pointers the newest chip's exit button carries an `Esc` kbd.
- **Chip.** `div.mode.glass[role=group][aria-labelledby]`, 40 px tall (44 coarse), pill radius: icon, title, detail, action buttons, exit button.
  - Only the ruler, aim and exposure details are `aria-live=polite`, as today.
  - Entering and leaving are announced through `bus 'announce'`.
- **It replaces:** `.vcap` (view-switch), the ruler and aim pills `.stool` (sky-tools), `.xp` (expose), `.hint` (the pick hint, `shell.js:110-113`) and `mountFlash`'s own slot (toast.js). `ui.flash` stays as an alias of `ui.modes.flash`, because `test/ui.night-vision.test.mjs` uses it.

| id | Shown while | Title · detail (whole phrases) | Actions | Exit (also Esc) |
|---|---|---|---|---|
| `view` | `view.vantage ∈ {l1, moon}` or `view.system` | today's `VANTAGE_CAPTION` pair (`view-switch.js:40-45`) | — | "Back to the globe" |
| `map` | `view.mode === 'map'` | "World map" · "Lines: sunset, civil, nautical and astronomical twilight. Dots: overhead now." | — | "Back to the globe" |
| `scope` | `ui.scope` | "Telescope on {name}" · "{fov}° field, followed" | — | "Leave the telescope" |
| `follow` | Sky view, `view.track !== 'none'`, no `ui.scope` | "Following {name}" / "Following the stars" | — | "Stop following" |
| `ruler` | `ui.ruler` | "Angle ruler" · today's instruction or result | — | "Done" |
| `aim` | `ui.aim` | "Pointing with your phone" · "Approximate: align on a bright body" | Align | "Stop" |
| `expose` | `ui.expose` | "Long exposure: {preset}" · `exposeStatusText()` | Save image | "Stop" |
| `loop` | `clock.range` (a loop, not a tween) | "Looping {from} → {to}" · "{n} s per loop, {playback}" | Edit (opens Time › Loop) | "Stop the loop" |
| `pick` | pick-on-globe | "Pick a place" · "Click or tap anywhere on Earth" | — | "Cancel" |

**Telescope state** (new; `js/app/actions.js`, which may touch the rig — `js/ui` still never imports three):
- `telescope(id)` also records `store.ui.scope = {id, fovDeg, prevFovDeg, prevTrack}`. `prevFovDeg` is `getView()?.fovDeg` before the zoom.
- New `leaveTelescope()` calls `rig().telescope(prevFovDeg ?? 60)`, restores `prevTrack` and clears `ui.scope`.
- `ui.scope` also clears when:
  - the view leaves Sky;
  - the selection changes;
  - Follow is set to "Look around freely";
  - the field of view grows past `max(10°, 3 × fovDeg)` because the user zoomed out. This is checked on the 4 Hz readout, never in rAF.
- **At boot**, a shared link with `view=sky`, a `sel` and a sky `cam` field ≤ 5° sets `ui.scope = {id: sel, fovDeg, prevFovDeg: 60, prevTrack: 'none'}`, so the chip and its Exit are there.
- `ui.scope` is never written to the URL.

### 4.5 Time bar and the Time popover (`timebar.js`)

**Desktop bar** (one row plus the scrubber):
```
[|◀ 1 h] (▶) [1 h ▶|]   📅 Sat 6 Feb 2027 · 20:00:00 · Greenwich, UTC+0 ▾   [⚠]   [− Real time +]   (● LIVE | Return to now)
═══════════════════════════════════════════════ scrubber ═══════════════════════════════════════════════
```

- **Step buttons** show the unit as text: `1 min`, `1 h`, `1 d`, `1 sid. day`, `1 mo`, `1 yr`.
  - Tooltip, two lines: "Back 1 hour", then "Shift: 1 day · Alt: 1 sidereal day". This documents the modifiers (P15).
  - The accessible name stays "Step back 1 hour".
  - Under a 760 px bar container the unit text hides; the glyph and name stay.
  - The phone bar has no step buttons; they live in the popover.
- **Date button** (`.tb-date`, keeping `.stamp__day` and `.stamp__time` for the smoke check).
  - New `.stamp__zone` span: Observer mode shows "{place short name}, UTC+0" (just "UTC+0" under a 940 px container); Device shows "This device, UTC+7"; UTC shows "UTC". Observer at Greenwich no longer looks like UTC (P16).
  - A `chevron-down` follows, which fixes the phone affordance (M12d).
  - Accessible name: `'Date and time: {stamp}, {zone}. Open the time panel'`.
- **The ⚠ accuracy badge** stays. Its sentence is also visible inside the popover.
- **Speed readout:** `fmtRate` as today ("Real time", or "1×" under a 400 px container).
  - While paused it gets `.is-paused` (muted) and the accessible name "Speed: {rate}, paused" (P16).
  - While a loop runs it reads "Loop" (was "Timelapse").
  - At 1×, the Slower tooltip reads "Slower (then backward)", since the ladder goes from 1 to −1.
- **Removed from the bar:**
  - `unitSel` and its `display:none` under 940 px (`css/app.css:1043-1045`, P3);
  - `btnReverse`;
  - `lapseBtn` and its hidden label;
  - `tzChip` and the cycle in `syncTz` (`timebar.js:541-566`);
  - `toolsEl` with the phone `arrange` branch (`:318-334`) and its shell wiring (`shell.js:254, 354-360`).

**Phone bar:** `(▶)  20:00:00 ▾ over Sat 6 Feb 2027 · UTC+0   [− 1× +]  [Now]`, then the scrubber. The play button sits outside the date button, which opens the popover.

**Time popover:** `div.popover.pop-time[role=dialog][aria-labelledby="pop-time-title"]`, non-modal, anchored to the date button. It is opened by `ui.openTime(section?)`, with `section ∈ 'go'|'step'|'loop'|'zone'`; the section is opened and its first control focused.
- Height: `max-height: calc(100dvh − 24px)`, scrolling inside. Below 560 px wide it goes full width (`openPopover`'s `fullWidthBelow`).
- It replaces the date popover and the lapse popover. One `openPopover` controller and the `closeDate()`/`closeLapse()` cross-calls go.

```
┌ Time ───────────────────────────────────────────────────── ✕ ┐
│ GO TO                                                          │
│ Date and time (Greenwich, UTC+0)  [2027-02-06T20:00:00]  [Go]  │
│ [Now] [Sunset 16:58] [Midnight] [Sunrise 07:28]                │
│ Dates before 15 October 1582 are Julian.  [Type a Julian date] │
│ ⚠ Positions are less accurate before 1800 and after 2200.     │  only when the badge shows
│ STEPPING                                                       │
│ Step buttons move by  [Hour ▾]                                 │  Minute · Hour · Day · Sidereal day (23 h 56 min) · Lunar month · Year
│ Shift-click: 1 day. Alt-click: 1 sidereal day.                 │  fine pointers only
│ Time runs  ( Forward | Backward )                          R   │  segmented; replaces Reverse
│ [‹ Back 1 hour]  [Forward 1 hour ›]                            │  phone only
│ ▸ Loop between two moments                                     │  <details>; open while a loop runs
│     From [ … ]  To [ … ]  One loop takes [10] s                │
│     Playback ( Loop | Back and forth | Once )                  │
│     [Stop]                                         [▶ Start]   │
│ SHOW TIMES IN                                                  │
│ ( Greenwich | This device | UTC )                              │  segmented → actions.setTzMode
│ [● ] 24-hour clock                                             │  switch → display.hour12
│ ▸ What the time bar shows                                      │  <details>
│     The colour is the Sun’s height: day, twilight, night.      │
│     The top edge shows when the selected planet is up.         │
│     The bottom edge shows when the Moon is up.                 │
│     Gold bars are eclipses, and ticks are events.              │
└────────────────────────────────────────────────────────────────┘
```

- The observer segment reads the place's short name, or "Your place" when there is none.
- **Renames:** "Ping-pong" becomes "Back and forth"; "Timelapse" becomes "Loop" everywhere, including the narrator's "Loop started" / "Loop stopped"; "Sid. day" becomes "Sidereal day (23 h 56 min)".
- **Fragment strings fixed** with `tpl()`: `timebar.js:282` (Julian sentence plus button), `:286` ("Date and time ({zone})") and `:304` ("Loop the clock between two moments. Times are in {zone}.").

### 4.6 Panel shell (`shell.js`)

```js
export const TABS = [
    { id: 'sky',     label: 'Up now',  icon: 'star',    title: 'What is in the sky now',            mount: mountSkyNow },
    { id: 'details', label: 'Details', icon: 'target',  title: 'The selected object',               mount: mountBodyCard },
    { id: 'events',  label: 'Events',  icon: 'events',  title: 'Upcoming events',                   mount: mountEventsPanel },
    { id: 'explore', label: 'Explore', icon: 'history', title: 'Tours, history and other places',   mount: mountExplore },
    { id: 'display', label: 'Display', icon: 'layers',  title: 'Layers and settings',               mount: mountDisplay },
];
```

- **Headings.** Tab panels drop their visible h2 that repeats the tab name ("Sky now", "Layers", "Settings"). A visually hidden `h2` keeps the heading outline for screen readers.
- **`selectTab`** also resets `sheetBody.scrollTop` (fixes M12a, `shell.js:150-151`).
- **Selection rule:**
  - Desktop is unchanged: a new selection switches to Details when Up now or Details is showing.
  - On phone, the raise-to-half rule from §3.3 is added.
- **`openPanel(id, {focus, sheet, reveal})`**: `reveal` is a section id inside the tab (`'about'`, `'conditions'`). The tab opens that `<details>` if it is one, scrolls it into view with `block: 'nearest'`, focuses its summary or first control, and adds `.is-flash` for 1.2 s. Under reduced motion `.is-flash` is an outline only, with no animation.
- **Handle fix (M5).** In `pointerdown` record the drag start, but call `sheet.setPointerCapture` only in `pointermove`, once the 4 px threshold is crossed (`shell.js:280`). A press that doesn't move then still delivers `click` to the handle.
- **Focus trap at full** covers the sheet and the nav: `trapFocus` accepts several roots (a 3-line change in `dom.js`). At peek only `.sheet__body` is inert; the nav is never inert.
- **Toasts** (M12c): `bottom: min(calc(var(--sheet-h) + var(--nav-h) + 12px), calc(100dvh − 140px))` in the mobile layout.
- **DOM order** (A1): in `index.html`, `<div id="ui-root">` moves before `<div id="labels-root">` (`:311-312`). Both are `position: fixed` with explicit z-indices, so nothing changes visually. The skip link becomes the first Tab stop and the canvas labels the last.
  - The skip link reads "Skip to the sky list" and targets `#tp-sky`.

### 4.7 Up now (`sky-now.js`, `sky-dome.js`, `tonight.js`)

```
┌ Up now ───────────────────────────────────────────────────┐
│ [Night]  Fully dark 18:52–05:35                         ⓘ  │  badge: Day / Twilight / Night / Solar eclipse
│ Sunset 16:58 · Sunrise 07:28                               │
│ New Moon, 0 % lit · City sky: stars to magnitude 3.6 (Bortle 9)  [Change] │  Change → Display › Sky conditions
│   ⓘ open: whole sentences — the Sun’s altitude, what “fully dark” means,
│           the Bortle scale, limiting magnitude, the aurora line when there is one
│ ┌ Two places (only with a second place; unchanged) ┐        │
│ ABOVE THE HORIZON · 5                                       │
│  ◔ ● Uranus        Sets 02:45 · mag 5.7       56° SSW  ∿    │  no Up badge
│  ◔ ● Jupiter       Sets 07:54 · mag −2.6      25° E    ∿    │
│  …                                                          │
│ BELOW THE HORIZON · 4                                       │
│  ◔ ● Venus         Rises 05:01 · mag −4.2     rises in 9 h  │
│  …                                                          │
│ ┌ Charts            ( Sky dome | Tonight )               ▴ ┐ │  ONE card
│ │  (the dome, or the Tonight chart)                       │ │
│ │  ( Looking up | Mirrored )     ▸ How to read this       │ │  orientation only on the dome
│ └─────────────────────────────────────────────────────────┘ │
│ Tip: press 1–9 to select a body and V for Sky view.         │
└────────────────────────────────────────────────────────────┘
```

- **Order:** summary, two-places card, list, Charts, tip. The list is the core text alternative, so it comes first (P3, P9).
- **Summary.** Three lines built from whole templates, replacing `status` and `summaryText` (`sky-now.js:106-107, 302-332`).
  - The badge loses "· Sun −28.5°"; the number moves into ⓘ (P12).
  - "Dark 18:52–05:35" becomes "Fully dark 18:52–05:35".
  - `skyDarknessText` (`:364-372`) becomes `'{class} sky: stars to magnitude {mag} (Bortle {n})'` by night and `'{class} sky (Bortle {n})'` by day. `{class}` is a lookup from `BORTLE_NAMES`, which moves from `settings.js` to `layers.js`.
  - ⓘ is a button with `aria-expanded` and `aria-controls`. Opening it moves focus into the revealed text (`tabindex=-1`).
  - Mars keeps `marsSummary`.
- **Rows:** delete `.body-row__badge` (`:152`). The group title says it, and the spoken row label keeps "above/below the horizon".
- **Charts card:** one `section.charts.card` with a header button (title "Charts", `aria-expanded`) and a segmented "Sky dome | Tonight".
  - It hosts the *bodies* of `mountSkyDome` and `mountTonight`. Their own heads, chevrons and metas are deleted: `.dome__head`, `.dome__meta` (which repeats the list), `.tonight__head` and `.tonight__meta` (which repeats sunset and sunrise).
  - The hidden chart gets no `update()`, and the dome's 1 Hz rebuild is gated on being shown (fixes the dome lane's open issue 2).
  - The dome legend and the Tonight legend move behind "▸ How to read this".
  - The dome orientation is renamed "Looking up | Mirrored", with the hint "Mirrored: east on the right, as printed sky maps often show it." The old "Map" clashed with the Map view.
  - **Default open:** desktop with `innerHeight ≥ 800`, and text mode. Closed on phones and short desktops. After the user toggles it, the pref decides.
- **Tip** (fixes the fragment string at `sky-now.js:143`):

  | Variant | Template |
  |---|---|
  | fine | `tpl('Tip: press {keys} to select a body and {v} for Sky view.', …)` |
  | coarse | today's coarse text |
  | text mode | `tpl('Tip: press {keys} to select a body.', …)` |

### 4.8 Details (`body-card.js`)

```
┌ Details ───────────────────────────────────────────────────┐
│ (disc) ● Jupiter                                            │
│        Planet                                               │  kind line without “· in Leo”
│ [Excellent tonight] best around 00:34, 54° high in the south · visible 17:54–06:44 · naked eye │
│ [✦ Look at it] [◉ Telescope] [⊕ Follow] [⋯ More ▾]          │  ← in the first ~150 px (phone half)
│ (satellites: next passes + Watch this pass)                 │
│ Jupiter is 25° above the east horizon, in Leo.              │  the constellation, once
│ ✋ Find it: face east, 2½ fists up from the horizon, …        │
│ ✦ The light you see left Jupiter 36 min 17 s ago.           │  a plain line, not a card
│ Altitude 25.0°          Azimuth 97° E                       │
│ Rise 17:12 · Transit 00:37 · Set 07:58                      │
│ Distance 4.363 AU · 652.8 million km                        │
│ Magnitude −2.6          Phase 100 % lit                     │
│ Angular size 44.2″      Constellation Leo                   │  “Leo (Leo)” → “Leo”
│ ▸ More positions                                            │  angle from the Sun (elongation), sky coordinates J2000 and of date, overhead point
│ ▸ What these numbers mean                                   │  every former title= hint, as visible dt/dd text
│ SHOW ON THE VIEW                                            │
│  Path ±6 months                               T  [● ]       │  the Display switch, same label (planets, Moon, extras with paths)
│  Where it’s up on Earth                       O  [ ●]       │  globe and map only
│  Sun paths and the analemma                      [ ●]       │  Sun only; replaces “The Layers tab draws them…”
│ THROUGH A SMALL TELESCOPE                                   │
│  (eyepiece portrait, unchanged)                             │
│ ▸ The year ahead · {planner sentence}                       │  closed by default (planets)
│ Tables show apparent, refracted values; …                   │
└────────────────────────────────────────────────────────────┘
```

**Action row.** There are never more than four buttons. The nine of today become these (P10):

| Control | Kind | Globe and map | Sky | Solar system | Text mode | Extras |
|---|---|---|---|---|---|---|
| **Look at it** (soft-accent, the one primary) | button | `select` + `setViewMode('sky')` (was "Look from here") | `select(id, {fly: true})` (was "Aim here") | `select` + `setViewMode('sky')` | — | ✓ |
| **Telescope** | toggle, `aria-pressed = ui.scope?.id === id` | ✓ (goes to Sky) | ✓ | ✓ | — | ✓ |
| **Follow** | toggle, `aria-pressed = track === 'body'` | — | ✓ | — | — | ✓ |
| **More ▾** | `menu()` | Turn the globe toward it (`flyToBody`, was "Center") · View the Earth from {name} (`viewFromBody`) · Earthrise (Moon; checkbox) · Compare from a second place… | Compare from a second place… | Compare from a second place… | Compare from a second place… (as a plain button) | Compare… |

- Earthrise, View the Earth from {name} and Compare hide on Mars, as today (`body-card.js:251-256`).
- **The verdict appears once:** the badge plus the old "Tonight:" line, merged (`card__tonight`, `:135`). The head badge goes. The badge is sentence case.
- **Renames:** "Sub-point" becomes "Overhead point"; "RA / Dec (J2000)" becomes "Sky coordinates (J2000)"; "RA / Dec (of date)" becomes "Sky coordinates (of date)". The abbreviations stay in "What these numbers mean".
- **The `title=` hints on fact labels are deleted** (`:117-133`). Their text lives in "What these numbers mean".
- **Empty state:** the nine body chips (`.bchip`, unchanged, with key hints), plus a `btn--soft` "Search for a star, comet or spacecraft" that calls `ui.openPalette()`.

### 4.9 Events (`events-panel.js`)

```
┌ Events ────────────────────────────────────────────────────┐
│ Next up                                                     │  sentence case, 12/600 accent
│ ┌───────────────────────────────────────────────────────┐   │
│ │ (glyph) Jupiter at opposition                          │   │
│ │ in 4 d 4 h · Thu 11 Feb · 00:17                        │   │
│ │ Closest and brightest for the year …                   │   │
│ │ [→ Jump to it]   [📅 Add to calendar]                  │   │  both labelled
│ └───────────────────────────────────────────────────────┘   │
│ (All)(Moon)(Planets)(Eclipses)(Meteors)(Satellites)(Seasons) │  radiogroup of chips
│ [📅 Add all 3 eclipses of the next 12 months to a calendar]  │  Eclipses: top; All: end (unchanged rule)
│ FEBRUARY 2027                                               │
│ [ (◑) First quarter                                   › ] [📅] │  the row is the Jump/Watch button
│ [     Sun 14 Feb · 07:59 · in 7 d 12 h                  ]      │
│ [     Moon in Aries, 375,700 km from Earth              ]      │
│ …   (the next 8 weeks, or at least 12 events)               │
│ [Show the rest of the 12 months (47 more)]                  │
│ Times are in the time bar’s zone. Choosing an event moves the clock, and the view where useful. │
└────────────────────────────────────────────────────────────┘
```

- **Moved to Explore:** tours, born under, moments and comets (`:112-125` and the code above them). The four section h2s and their pills go ("Narrated", "Next 12 months", "Links", "Halley").
- **Rows.** Each row is one `button.ev` (glyph, title, when, detail, trailing chevron), keeping today's `data-ev` and accessible name. The separate Jump button is deleted. The calendar button stays at the right edge: `btn--icon`, 44×44 on coarse, named "Add {title} to a calendar".
- **Window:** the next 8 weeks or at least 12 events, whichever is more. `Show the rest of the 12 months ({n} more)` reveals the rest and focuses the first newly shown row. The other filters are short and show all 12 months.
  - Expected height: about 2,000 px at 1440×900 (today 14,551), with about 35 tab stops (today 237).
- **Filters:** `div[role=radiogroup][aria-label="Show"]` of `.chip[role=radio][aria-checked]`. They use the same roving key handler as `segmented` (factored out as `rovingKeys` in `dom.js`), replacing the `aria-pressed` toggles (P11).

### 4.10 Explore (new `js/ui/explore.js`; mostly code moved from `events-panel.js`)

```
┌ Explore ───────────────────────────────────────────────────┐
│ GUIDED TOURS                                                │  hidden in text mode
│ [▶ tour 1      ] [▶ tour 2      ]                           │  today's four tour cards, unchanged
│ [▶ tour 3      ] [▶ tour 4      ]                           │
│ THE SKY YOU WERE BORN UNDER                                 │
│ Your birthday, seen from where you are now.                 │
│ Date [          ]  Time [21:00]  [✦ Show my sky]            │  today's form, unchanged
│ MOMENTS IN HISTORY · 13                                     │
│  (first 4 links)                                            │
│ [Show all 13 moments]                                       │
│ FAMOUS COMETS · 5                                           │
│  (first 3 links)                                            │
│ [Show all 5 comets]                                         │
│ OTHER PLACES                                                │
│ [⇄ Two places at once      A second pin and its beams, compared in Up now   ›] │
│    with a second place: “Comparing with {place}” [Change] [Remove]              │
│ [♂ Stand on Mars           The sky from a landing site, with the Earth as an evening star ›] │  hidden in text mode; on Mars: “Back to the Earth”
│ Dates before 15 October 1582 are Julian, as the records give them. …            │
└────────────────────────────────────────────────────────────┘
```

- **Two places at once** runs `actions.compareWith()`, which opens Search in compare mode. Remove calls `setObserver2(null)`.
- **Stand on Mars** sets `ui.palette = 'mars'`, today's footer action (`location.js:527-528`). On Mars it calls `leaveMars`.
- Moment and comet links keep `a[href=hash]`, and they still lower the phone sheet to peek (`events-panel.js:128-133`). "Show my sky" does the same.
- "Show all" removes itself and focuses the first newly shown link.

### 4.11 Display (`layers.js` keeps `LAYER_GROUPS` and gains `mountDisplay`; `settings.js` is deleted)

```
┌ Display ───────────────────────────────── [Reset layers] ┐
│ Layers for the globe view.                                │  or “…for the Sky view”; map and system count as globe
│ BEAMS AND LABELS                                          │
│  Beams                                       B   [ ●]     │
│  Beams through the Earth                         [ ●]     │
│    Dashed where a beam passes through the planet          │
│  Sun and Moon beams                              [ ●]     │
│  Labels                                          [ ●]     │
│ STARS                                                     │
│  Stars · Constellation lines (C) · Constellation names (Shift C) · Star names · Milky Way (Shift M) · Deep-sky objects │
│ GUIDES                                                    │
│  Ecliptic (E) · Equatorial grid (RA/Dec) (G) · The pole’s 26,000-year circle (precession) · Sun paths and the analemma · Path ±6 months (T) │
│ EARTH                                                     │
│  Clouds · Atmosphere · Horizon disc · Where it’s up on Earth (O) · Overhead points │
│ IN ORBIT                                                  │
│  Satellites · Spacecraft                                  │
│ ▸ Only in Sky view · 4                                    │  <details>, closed: Horizon grid, Illustrative landscape, Meteors, …
│ SKY CONDITIONS                                            │  id “conditions” (Up now › Change reveals it)
│  Light pollution     [Auto (from your place) ▾]           │  select (11 options), today’s hint
│  Aurora              ( Quiet | Typical | Storm )          │  segmented (was a select)
│  Typical: Kp 3, the ovals on an ordinary night.           │  Kp moves into the hint
│ QUALITY                                                   │  hidden in text mode
│  ( Auto | Low | Medium | High | Max )                     │
│  Running: Medium · chosen for this device                 │
│ COMFORT                                                   │
│  Night vision                              Shift N  [ ●]  │
│  Animations follow your system’s motion setting.          │
│ ▸ About this app · version {VERSION}                      │  <details> id “about”: about.js content (hero, Install,
│                                                           │  Report a problem moved up, Accuracy, Credits, Privacy, Source, notices)
│ [▶ Replay intro]   [↺ Reset all settings]                 │  inline confirm, unchanged
└──────────────────────────────────────────────────────────┘
```

- **Data.** Each `LAYER_GROUPS` item gains a `where` field (`'globe' | 'sky' | 'both'`). The groups are by meaning:

  | Group | Layer | `where` |
  |---|---|---|
  | Beams and labels | beams | globe |
  | | ghostBeams | globe |
  | | sunMoonBeams | globe |
  | | labels | both |
  | Stars | stars, constellations, constellationNames, starNames, milkyWay, deepSky | both |
  | Guides | ecliptic, eqGrid, precession, sunPath, trails | both |
  | | altAzGrid | sky |
  | Earth | clouds, atmosphere, horizon, footprint, subpoints | globe |
  | | landscape | sky |
  | In orbit | satellites | both |
  | | spacecraft | globe |
  | | meteors | sky |

  **Each value must be confirmed** against the render module's `setViewMode`/`setLayers`, with a screenshot of each layer in both views. A wrong value hides a layer inside the collapsed group.
- **The current view's** groups list items with `where ∈ {view, 'both'}`. One closed `<details>` titled `'Only in Sky view · {n}'` or `'Only on the globe · {n}'` lists the rest, each row in its own group order.
- **Label renames.** The descriptions stay as they are. `actions.js` `LAYER_LABELS`, the shortcut flashes (derived from `LAYER_GROUPS`) and the help rows (now generated from `LAYER_GROUPS` items with `keys`) all follow.

  | Old | New |
  |---|---|
  | Through-Earth beams | Beams through the Earth |
  | Sun & Moon beams | Sun and Moon beams |
  | Equatorial grid (of date) | Equatorial grid (RA/Dec) |
  | Precession | The pole’s 26,000-year circle (precession) |
  | Sub-points | Overhead points |
  | Visibility footprint | Where it’s up on Earth |
  | Path of selected body | Path ±6 months |
  | Sun paths & analemma | Sun paths and the analemma |
  | Horizon grid (Sky view) | Horizon grid |
  | Illustrative landscape (Sky view) | Illustrative landscape |
  | Meteors (Sky view) | Meteors |

- **Reset layers** (ghost button, top right) restores `DEFAULT_STATE.layers` in one `store.set`. It flashes "Layers reset to their defaults".
- **Moved in from `settings.js`, with their actions unchanged:**
  - Sky conditions (`settings.js:61-82`; `setSkyDark`, `setAuroraActivity`);
  - Quality (`:37-46`);
  - Night vision (`:90-95`);
  - the motion note;
  - Replay intro;
  - Reset all settings.
- **Deleted from Settings** (each moved to its owner): Show times in and 24-hour clock go to the Time popover; Lock view to Earth goes to Tools; the shortcuts and tips buttons go to ⋯ and Help. Settings' "Show interface tips" button is deleted (⋯ and the help foot keep it).
- **About.** `mountAbout(root, ctx)` keeps its signature and mounts into the About `<details>` body.
  - Inside it, "Report a problem" moves up to directly after the hero and Install.
  - The About keyboard-shortcuts button is deleted.
  - The summary carries `VERSION`. Bumping `js/version.js` to 2.1.0 is the release commit's job, not this redesign's.
- **Text mode:** only Sky conditions, Comfort, About and App, plus the note in §3.4.

### 4.12 Help (`help.js`)

- **New "Mouse" group** (`.for-fine`, P14). It is the fine-pointer twin of `GESTURES` (`help.js:63`):
  - "Click a world, its label or a row: select it."
  - "Click the Earth: stand there (Undo in the message)."
  - "Double-click: fly closer; in Sky view, glide there and zoom in."
  - "Drag: turn the globe; in Sky view, look around."
  - "Scroll: zoom, from a telescope’s field out to the whole solar system."
- **Changed rows:**
  - Esc: "Esc: close a menu or dialog, then leave the newest mode shown at the top of the view, then clear the selection."
  - Home: "Reset the view (also in Tools)".
  - H: "Hide the interface (also in ⋯)".
  - Steps: "Shift or Alt with a step button or , . : step 1 day or 1 sidereal day".
  - `/`, Ctrl+K: "Search places and the sky".
- **The Layers group is generated** from `LAYER_GROUPS` items that have `keys`. The hand-written copy at `help.js:44-53` is deleted, so names stay identical in Display, Details, Help and the flash.
- `helpButton()` is deleted: no Settings or About copy remains. `SHORTCUTS` stays exported, including the Shift+N row (`test/ui.night-vision.test.mjs:106-113`).
- The title stays "Keyboard shortcuts and mouse" (fine) / "Gestures" (coarse).

### 4.13 Eclipse HUD, coach, tours, toasts, intro

- **Eclipse HUD** (`eclipse-hud.js`):
  - The kicker reads "Eclipse companion · {place}" in sentence case.
  - Contacts read plain first: Begins / Totality / Peak / Totality ends / Ends. The codes C1…C4 sit underneath as 11 px sub-labels. Lunar eclipses read Partial begins / Total begins / Peak / Total ends / Partial ends, with U1…U4 and P1/P4.
  - "Jump to C2 − 20 s" becomes "Jump to just before totality" ("…before annularity"; for a partial eclipse, "Jump to the peak").
  - Each node's `aria-label` is the long phrase. Buttons are 44 px tall on coarse pointers.
  - The phone auto-collapse is described in §3.3.
- **Coach** (`coach.js:126-140`):
  - Step 1 on phone targets `#labels-root .lbl--body[data-id]:not(.is-hidden)`, then `.ui .tabpanel--sky .body-row[data-id]`. The `.strip .bchip` selector is deleted along with the strip.
  - Step 2 (`.ui .tb-scrub`) is unchanged.
  - Step 3 (`.ui .seg--view`) is unchanged, with new copy: "Globe, Sky or Map: choose how you look."
- **Tours:** unchanged. Esc still ends a tour first (`tours.js:662`, capture phase).
- **One-time "what moved" toast.** Shown to returning users only: `introSeen` is true and the new pref `uiVersion` is below 2. Text: "Settings are now in Display, and tours and history are in Explore." Action "Show me" opens Display. It lasts 10 s and sets `uiVersion: 2`.
- **Intro, caption, the iOS Home Screen toast and the update toast:** unchanged.

---

## 5. Interaction rules

### 5.1 Escape, one order (`shortcuts.js` `onEscape`, replacing `:54-66`)

1. **Handled before the window listener (unchanged):**
   - open menus and popovers (`openPopover` stops propagation);
   - modal dialogs: Search, Help, Postcard, Video, the share fallback and the coach tip. Search now closes in one press;
   - a running tour (the capture handler in `tours.js`);
   - the phone sheet at full, which goes to half and focuses the handle (`shell.js:331`).
2. Search open → close. Help open → close. These are fallbacks, as today.
3. Focus in a text field → blur.
4. Cinema → show the interface.
5. **`ui.modes.exitTop()`.** It runs the newest chip's exit and flashes its result ("Telescope off", "Back to the globe", "Loop stopped", "Not following", "Ruler off").
   - **Exposure guard:** when the newest chip is `expose` with ≥ 1 frame stacked, the first Esc flashes "Press Esc again to stop the exposure, or choose Save image". A second Esc within 3 s stops it. With 0 frames it stops at once.
6. Selection → deselect.

This replaces the separate vantage, ruler, aim, map and system branches. It adds telescope, exposure, loop and follow (P5, P6). The pick hint's own capture listener is deleted (`shell.js:431-441`), because `pick` is a mode now.

| State | Esc today | Esc after |
|---|---|---|
| Search with text | clears the text | closes |
| Telescope on Jupiter | deselects; the zoom stays | leaves the telescope (field restored); the next Esc deselects |
| Exposure running, frames > 0 | deselects; the exposure keeps stacking | warns; a second Esc stops it |
| Loop running | deselects; the loop runs on | stops the loop |
| Following the stars | deselects | stops following |
| Map / L1 / Earthrise / system | back to the globe | back to the globe (unchanged) |
| Ruler, aim | off | off (unchanged) |
| Pick on the globe | cancels (own handler) | cancels (mode) |
| Nothing but a selection | deselects | deselects |

### 5.2 Keyboard shortcuts: all kept, all discoverable

Every key keeps its meaning: Space, `[` `]`, R, `,` `.` with Shift/Alt, N, Shift+N, 1–9, 0, V, M, L, K, A, B, C, Shift+C, Shift+M, E, G, O, T, `/`, Ctrl/⌘+K, S, F, H, Home, `` ` ``, ?, Esc, plus the arrows and +/− for the camera.

Changes:
- **Esc** follows §5.1.
- **K** cycles Look around freely → Follow {name} → Follow the stars. The flash names the new state.
- **L** flashes "Turning with the Earth" / "Holding the view still".
- **V** toggles Globe and Sky. **M** toggles Map and Globe.

Where shortcuts are shown (A5):
- the menu rows' kbd column;
- Display switch rows (as today);
- the step-button and segment tooltips (`data-kbd`);
- the Time popover (R, Shift/Alt);
- Help.

On `body.is-coarse` kbd hints stay hidden outside Help, as today (CSS section 20).

### 5.3 Focus

- **Menus:** focus the checked radio or the first item on open. Esc returns focus to the button; Tab moves on.
- **Time popover:** focuses the date input, or the first control of the requested section. Esc returns to the date button.
- **Search:** focuses the input. Close returns focus to the opener (the chip, or the Details empty-state button).
- **Mode chips** never take focus when they appear. Their exit buttons are in the Tab order after the toolbar.
- **Tab changes:** focus stays on the tab. `openPanel(id, {focus: true})` and the skip link focus the panel.
- **Desktop Tab order:** skip link → location chip → status chips → Eclipse HUD → toolbar → time bar → tabs → panel content → canvas labels.
- **Phone:** the trap at full covers the sheet and the nav (§4.6).

### 5.4 ARIA patterns

| Widget | Pattern |
|---|---|
| Panel tabs, rail and phone tab bar | `tablist`/`tab`/`tabpanel`, roving tabindex, arrows (vertical in the rail), Home/End. One node, moved between layouts. |
| View segment, Quality, Aurora, Time runs, Show times in, Playback, Charts switch, dome orientation, postcard and video presets | `radiogroup` + `radio`, roving, arrows (`segmented`) |
| Event filters | `radiogroup` of chips (`rovingKeys`) |
| Layer, Night vision, 24-hour, Path, "Where it’s up", Sun paths | `switchRow` (`role=switch`, `aria-checked`), unchanged |
| Tools, Share, ⋯, Details More | menu button (`aria-haspopup=menu`, `aria-expanded`) + `role=menu` with `menuitem` / `menuitemradio` in `role=group` / `menuitemcheckbox`, plus `role=separator` |
| Time popover | non-modal `role=dialog`, `aria-labelledby`, focus moved in |
| Search, Help, Postcard, Video, share fallback, coach | modal dialogs, unchanged |
| Collapsible groups (Charts, ⓘ, More positions, What these numbers mean, The year ahead, Only in…, Loop, What the time bar shows, About) | native `<details>`/`<summary>`; never a control inside a summary. Charts uses a header button with `aria-expanded` because its head holds a radiogroup. |
| Telescope and Follow in Details | `button[aria-pressed]` with a ✓ icon when pressed |
| Status stack | `role=region aria-label="Active modes"`; each chip `role=group aria-labelledby`; ruler, aim and expose details `aria-live=polite`; the flash `aria-hidden` |
| Sheet handle | button, `aria-expanded`, `aria-controls`, 44 px hit area |

### 5.5 Announcements (whole phrases)

New:
- "Telescope on {name}." / "Telescope off."
- "Following {name}." / "Following the stars." / "Not following."
- "Loop started." / "Loop stopped."
- "Times in {zone}."
- "{n} more events shown."
- "Layers reset to their defaults."

Existing announcements stay. The narrator's selection and time narration are unchanged.

### 5.6 Reduced motion

The existing behaviour stays: `--t1` and `--t2` go to 0 s, the sheet snaps (`no-anim`), and the 200 ms fade softens cuts.

New surfaces:
- Menus and the Time popover appear with opacity only, and instantly under reduced motion.
- `<details>` never animate height.
- Chips appear in place.
- The raise-on-selection snaps.
- `.is-flash` is an outline with no animation.
- The Charts switch has no cross-fade.

---

## 6. What is deleted (and where it went)

| Deleted | Replaced by |
|---|---|
| Top-bar search button (`topbar.js:49-52`) | the location chip (⌕) |
| `.vb-lock`, `.vb-vantage`, `.vb-track`, `.vb-expose`, `.vb-fs`, `.vb-help`, sky-tools ruler and point buttons | Tools, Share, ⋯ |
| `mountMoreMenu`, the hand-written vantage menu, share popover (`role=dialog`) and expose popover | `menu()` in `dom.js` |
| `.vcap`, `.stool`/`.stools` positioning, `.xp` pill, pick `.hint`, the flash's own slot | `modes.js` status stack |
| Time bar `unitSel`, `btnReverse`, `lapseBtn`, `tzChip` (and its cycle), `toolsEl`, the mobile `arrange` branch, separate date and lapse popovers | the Time popover |
| Phone body strip (`mountBodyStrip`, `sky-now.js:479-552`, `.strip` CSS, shell wiring) | globe labels, the Up now list (one tap in the tab bar), Search › In the sky |
| Settings tab and `settings.js` | Display, Time popover, Tools, ⋯ |
| About tab | Display › About this app; ⋯ › About, credits and help |
| `helpButton()` and its copies in Settings and About | ⋯ › Keyboard shortcuts and mouse; ? |
| Events' tours, born under, moments and comets sections; four h2s and pills; per-row Jump buttons | Explore; the row is the button |
| Sky dome and Tonight card heads, chevrons and metas; `.body-row__badge` | the Charts card; group titles |
| Details: nine action buttons; head verdict badge; `card__tonight` box; fact `title=` hints; "· in Leo" in the kind line; "Leo (Leo)"; the light-time card chrome | the action row, switch rows, merged verdict and disclosures |
| Palette: clear-on-first-Esc; offline heading and paragraph; Compare and Stand on Mars footer buttons | one-press close; the footer status; Explore and Details More |
| Shortcuts' five mode branches; the pick hint's capture-phase Esc listener | `ui.modes.exitTop()` |
| Hand-written help Layers rows | generated from `LAYER_GROUPS` |
| CSS: `.ui:not([data-layout="mobile"]) .vb-more{display:none}`, the 940 px `display:none`, `.tb-tz*`, `.tb-lapse*`, `.tb-tools`, `.strip*`, `.vcap*`, `.xp` pill, `.share-opt*`, `.xp-opt*`, `.pill` variants, `.ev__jump`, `.ev-next__eyebrow`, `.dome__head/__meta/__chev`, `.tonight__head/__meta/__chev`, `.card__light` chrome, 6 help-text classes, 3 pill variants; icons `lock`, `unlock` | the tokens and components in §9 |

---

## 7. Every feature: old location → new location

`=` means unchanged. Each row names the new primary home first, then secondary routes. Nothing is removed without a stated replacement.

### 7.1 Persistent chrome

| # | Feature / control | Old | New |
|---|---|---|---|
| 1 | Wordmark | top-left | = (mark only under a 1100 px canvas) |
| 2 | Location chip → palette | top bar; `/`, Ctrl+K | = ; now "Search places and the sky" |
| 3 | Search button | top bar icon | **deleted (duplicate)** → the chip; `/`, Ctrl+K |
| 4 | Back to Earth (on Mars) | top bar; palette Mars mode | = ; plus Explore › Stand on Mars card ("Back to the Earth") |
| 5 | Panel tabs ×6 | panel head; sheet | Up now · Details · Events · Explore · Display (phone: bottom tab bar) |
| 6 | Collapse panel / rail | panel head | = ; the rail shows icon and label |
| 7 | Skip link | 11th Tab stop | 1st Tab stop ("Skip to the sky list") |
| 8 | Step back / forward | time bar; phone tools row | time bar, labelled with the unit (desktop); phone: Time popover › Stepping |
| 9 | Shift/Alt-click on step buttons | undocumented | tooltips; Time popover; Help |
| 10 | Play / pause | time bar | = |
| 11 | Step size select | time bar (hidden < 940 px); tools row | Time popover › Stepping › Step buttons move by |
| 12 | Go to date and time, quick jumps, Julian entry | date popover | Time popover › Go to (from the date button) |
| 13 | Reduced-accuracy badge | time bar (text in tooltip) | = ; plus a visible sentence in Time › Go to |
| 14 | Time zone Observer/Device/UTC | tz chip cycle; Settings segmented | the zone is shown in the date button; choice in Time popover › Show times in |
| 15 | 24-hour clock | Settings | Time popover › Show times in |
| 16 | Mars sol / LMST stamp | date button | = |
| 17 | Slower / rate / faster | time bar | = (paused and loop states shown) |
| 18 | Reverse | time bar icon; R | Time popover › Time runs Forward/Backward; R; Slower past 1× |
| 19 | Timelapse (range loop) | time bar icon + popover | Time popover › Loop between two moments; `loop` chip (Edit, Stop) |
| 20 | LIVE / Return to now | time bar | = |
| 21 | Scrubber (sky colours, Moon band, planet band, eclipse bars, ticks) | time bar | = ; legend in Time › What the time bar shows |
| 22 | Globe \| Sky | toolbar | Globe \| Sky \| Map segment |
| 23 | Lock view to Earth | toolbar icon; Settings; L | Tools (globe) › Turn with the Earth; L |
| 24 | Vantage menu › Globe | toolbar | Globe segment; Tools › Look from › Near the Earth; chip "Back to the globe"; Esc |
| 25 | World map | vantage menu; M | Map segment; M; `map` chip |
| 26 | View from L1 | vantage menu | Tools (globe) › Look from › The L1 point; `view` chip |
| 27 | Earthrise | vantage menu; Details (Moon) | Tools (globe) › Look from › Earthrise; Details › More (Moon) |
| 28 | Solar system | vantage menu; wheel | Tools (globe) › Look from › The whole solar system; wheel |
| 29 | Vantage caption + Globe back | top centre | `view` / `map` chips |
| 30 | Share link | Share popover; S | Share › Share link; S |
| 31 | Postcard | Share popover; Expose › Save image | Share › Postcard…; `expose` chip › Save image |
| 32 | Time-lapse video | Share popover | Share › Time-lapse video… (preset "A night of turning stars") |
| 33 | Share-link fallback dialog | on failure | = |
| 34 | Fullscreen | toolbar icon (desktop); ⋯ (phone); F | ⋯ › Fullscreen (all layouts); F |
| 35 | Help / shortcuts (5 entry points) | toolbar ?, Settings, About, ⋯, ? | ⋯ › Keyboard shortcuts and mouse; ?; help foot keeps tips |
| 36 | Track off/body/stars | toolbar cycle icon; Details Track; K | Tools (sky) › Follow radios; Details › Follow toggle; K; `follow` chip |
| 37 | Angle ruler | toolbar icon (sky); A | Tools (sky) › Angle ruler; A; `ruler` chip |
| 38 | Point at the sky | toolbar icon (phone, sky) | Tools (sky) › Point the phone at the sky; `aim` chip |
| 39 | Long exposure presets | toolbar icon → popover | Tools (sky) › Long exposure items; `expose` chip (Save image, Stop) |
| 40 | ⋯ More menu | phone only | every layout |
| 41 | Interface tips | Settings; help foot; ⋯ (phone) | ⋯; help foot |
| 42 | Hide the interface | H; ⋯ (phone) | ⋯ (all layouts); H |
| 43 | Show interface (cinema exit) | overlay | = |
| 44 | Night vision | Settings › View; ⋯ (phone); Shift+N | Display › Comfort; ⋯ (all layouts); Shift+N |
| 45 | Eclipse Companion HUD (Play, Jump, Stand in the path, collapse) | top-left | = ; plain contact names; auto-collapse on phone; 44 px buttons |
| 46 | Guided tour lower third | bottom centre | = |
| 47 | Pick-on-globe hint | top overlay | `pick` chip (Cancel; Esc) |
| 48 | Toasts (Undo, copied, update, reduced detail, iOS hint) | bottom | = ; clamped at full on phone |
| 49 | Coach marks | first visit | = ; phone step 1 targets a globe label |
| 50 | Intro and caption | first visit | = ; Display › App › Replay intro |
| 51 | Click/tap a world → select | view | = ; phone raises the sheet to Details |
| 52 | Click the Earth → move (Undo) | view | = ; documented in Help › Mouse (see §12 for the phone owner decision) |
| 53 | Double-click fly; drag; wheel; arrows; +/− | view | = ; documented |
| 54 | Reset camera | Home only | Tools › Reset the view; Home |
| 55 | Select a star, DSO, comet, guest star, craft or satellite | click in the view only | = ; Search › In the sky; Details empty state "Search for…" |
| 56 | Edge chips in Sky view | view | = |
| 57 | Reduced-motion fade | overlay | = |
| 58 | Context-loss overlay, context-unstable banner, reduced-detail toast, update toast | overlays | = |

### 7.2 Panel content

| # | Feature | Old | New |
|---|---|---|---|
| 59 | Status pill "Night · Sun −28.5°" | Sky tab head | Up now badge "Night"; the altitude in ⓘ |
| 60 | Summary line (sunset, sunrise, dark, Moon, Bortle, aurora) | Sky tab | Up now summary (3 lines) + ⓘ; "Change" → Display › Sky conditions |
| 61 | Sky dome (tap to select, FOV wedge) | Sky tab card 1 | Up now › Charts › Sky dome |
| 62 | Dome orientation Looking up \| Map | dome card | Charts › Sky dome › Looking up \| Mirrored |
| 63 | Tonight chart (drag scrubs) | Sky tab card 2 | Up now › Charts › Tonight |
| 64 | Two places card (Show both beams, change, remove) | Sky tab | = (Up now, above the list) |
| 65 | Body list with compass, rise/set, mag, alt·dir, sparkline | Sky tab, below the fold | Up now, first; Up/Down badges deleted |
| 66 | Sky tab tip | foot | = (whole-phrase variants) |
| 67 | Details empty state (nine chips, keys) | Details | = ; plus "Search for a star, comet or spacecraft" |
| 68 | Name, disc, kind | Details head | = (kind without the constellation) |
| 69 | Verdict badge | Details head | merged with the tonight line, under the name |
| 70 | Position sentence | Details | = (the one place the constellation is named) |
| 71 | Find it | Details | = |
| 72 | Light time | Details card in card | a plain line |
| 73 | Moon extras | Details | = |
| 74 | Sun paths text ("the Layers tab draws them…") | Details (Sun) | a "Sun paths and the analemma" switch row |
| 75 | Satellite passes + Watch this pass | Details | = (directly under the action row) |
| 76 | Eyepiece portrait | Details, above the actions | Details › Through a small telescope (after the facts) |
| 77 | Look from here / Aim here | Details | Details › Look at it |
| 78 | Center | Details | Details › More › Turn the globe toward it (globe); Look at it (sky) |
| 79 | Telescope (one-shot) | Details | Details › Telescope toggle; Tools (sky) › Telescope on {name}; `scope` chip |
| 80 | Track | Details (sky) | Details › Follow toggle; Tools (sky) › Follow |
| 81 | View from {body} | Details (globe) | Details › More › View the Earth from {name} |
| 82 | Earthrise | Details (Moon) | Details › More › Earthrise; Tools (globe) › Look from |
| 83 | Path ±6 months | Details pressed button; Layers; T | Details › Show on the view switch; Display › Guides; T |
| 84 | Show where it's visible | Details pressed button; Layers; O | Details › "Where it's up on Earth" switch; Display › Earth; O |
| 85 | Compare with… | Details; palette footer | Details › More › Compare from a second place…; Explore › Two places at once |
| 86 | Tonight line | Details box | merged with the verdict |
| 87 | Year planner + Jump to its best night | Details, above the facts | Details › The year ahead (collapsible, after the facts) |
| 88 | Fact grid incl. RA/Dec and sub-point | Details | core facts; More positions; What these numbers mean |
| 89 | Extras card (lines, facts, caveat, sources) | Details | = |
| 90 | Guided tours (4) | Events top | Explore › Guided tours; `tour=` |
| 91 | Event filters | Events | = (radiogroup) |
| 92 | Next up (Jump + calendar) | Events | = (both labelled) |
| 93 | 12-month list | Events (all rows) | Events: 8 weeks or 12 events, then "Show the rest of the 12 months" |
| 94 | Per-event Jump / Watch | button per row | the row itself |
| 95 | Per-event calendar (.ics) | icon per row | = |
| 96 | Add all eclipses (.ics) | Events (All end / Eclipses top) | = |
| 97 | Satellite passes in Events (Watch) | Events | = |
| 98 | The sky you were born under | Events at 12,061 px | Explore, second section |
| 99 | Moments in history | Events at 12,211 px | Explore (4, then Show all) |
| 100 | Famous comets | Events at 14,175 px | Explore (3, then Show all) |
| 101 | Mars note | Events | = |
| 102 | 25 layer switches + key hints | Layers, flat | Display, grouped by the current view; the other view's layers in "Only in …" |
| 103 | Clouds "Not drawn at Low quality" note | Layers | = |
| 104 | Quality + Running | Settings | Display › Quality (hidden in text mode) |
| 105 | Show times in | Settings + tz chip | Time popover |
| 106 | 24-hour clock | Settings | Time popover |
| 107 | Sky darkness | Settings | Display › Sky conditions › Light pollution; Up now › Change |
| 108 | Aurora activity (select) | Settings | Display › Sky conditions › Aurora (segmented) |
| 109 | Lock view to Earth (Settings copy) | Settings › View | deleted duplicate → Tools |
| 110 | Night vision (Settings copy) | Settings › View | Display › Comfort |
| 111 | Replay intro | Settings | Display › App |
| 112 | Show interface tips (Settings copy) | Settings | ⋯; help foot |
| 113 | Keyboard shortcuts button (Settings, About) | Settings; About | ⋯; ? |
| 114 | Reset all settings (inline confirm) | Settings | Display › App |
| 115 | Reduced-motion note | Settings | Display › Comfort |
| 116 | About hero + version | About tab | Display › About this app (the summary shows the version) |
| 117 | Install app | About | Display › About this app; ⋯ › Install the app (when offered) |
| 118 | Accuracy, Credits, Privacy | About | Display › About this app |
| 119 | Copy diagnostics, Report an issue | About, bottom | Display › About this app, right after the hero |
| 120 | Source code, Third-party notices | About foot | Display › About this app |

### 7.3 Dialogs, menus, popovers

| # | Surface | Old | New |
|---|---|---|---|
| 121 | Location palette (coordinates, examples, cities, online, recent, place sky pills) | modal | = ; plus "In the sky"; one-press Esc; one offline message |
| 122 | Use my location, Pick on the globe | palette footer | = |
| 123 | Palette Mars mode (sites, lat/lon) | footer "Stand on Mars…" | opened from Explore; = inside |
| 124 | Palette compare mode, Stop comparing | footer / Details | opened from Explore and Details More; = inside |
| 125 | Online search status | palette, three times | footer only |
| 126 | Go to date & time popover | date button | Time popover › Go to |
| 127 | Timelapse popover | lapse icon | Time popover › Loop |
| 128 | Vantage menu | toolbar | Tools (globe) › Look from |
| 129 | Share popover (`role=dialog`) | toolbar | Share menu (`role=menu`) |
| 130 | Long exposure popover | toolbar | Tools (sky) › Long exposure group |
| 131 | Postcard dialog | Share; Expose › Save | = |
| 132 | Time-lapse video dialog | Share | = ; preset renamed |
| 133 | Help dialog | ?, toolbar, Settings, About, ⋯ | ? and ⋯; plus the Mouse group |
| 134 | Coach tip dialog | first visit | = |

### 7.4 URL, keys and phone-specific

| # | Item | New |
|---|---|---|
| 135 | `tour=`, `debug=1`, `` ` ``, `sw=`, `intro=`, `q=`, `cam=`, `hloc=`, `loc2=`, `host=`, `view`, `sel`, `trk`, `vt`, `lock`, `ly`, `sky`, `au` | = |
| 136 | `tab=` | `sky`, `details`, `events` =; new `explore`, `display`; aliases `layers` → Display, `settings` → Display (reveal `conditions`), `about` → Display (reveal `about`) |
| 137 | Manifest shortcuts (Sky view, Upcoming events) | = (`#view=sky`, `#tab=events`) |
| 138 | H, Home, Shift/Alt-step, Shift+N (key-only on desktop) | plus ⋯, Tools, tooltips and Time popover, ⋯ and Display |
| 139 | Wheel past the telescope range to the solar system | = ; plus Tools › Look from › The whole solar system |
| 140 | Sheet handle (18 px) | 44 px hit area; mouse click fixed |
| 141 | Phone body strip | **deleted** (see §6) |
| 142 | Time-bar tools row | **deleted** → Time popover |
| 143 | Floating column (5–7 icons) | labelled: Globe/Sky/Map, Tools, Share, ⋯ |
| 144 | Tabs in the sheet | bottom tab bar |

### 7.5 Phase 7 lane touchpoints

| # | Touchpoint | New |
|---|---|---|
| 145 | `tonight.js` card, pref `tonightOpen` | Charts › Tonight; pref folded into `skyDome` (§10) |
| 146 | Row sparklines, `downText()` | = |
| 147 | Time-bar palette, Moon band, planet band, eclipse bars (`sky-palette.js`) | = ; plus the legend |
| 148 | `sky-dome.js` card, pref `skyDome` | Charts › Sky dome; `skyDome.chart` added |
| 149 | Event glyphs, per-row .ics, bundle | = |
| 150 | Picker place preview pill | = |
| 151 | `.for-fine` / `.for-coarse` copy; kbd hidden on coarse | = |
| 152 | Install button (About) + iOS hint toast | Display › About; ⋯ when offered; toast = |
| 153 | Night-vision filter, early apply | = ; ⋯ item on every layout; switch in Display › Comfort |
| 154 | CSS section 22 media blocks, focus halo | kept and extended (§10.5) |
| 155 | Diagnostics (`report.js`) | Display › About this app, after the hero |
| 156 | Context-loss overlay, SW update toast | = |

---

## 8. Code plan

### 8.1 Add

| Where | What |
|---|---|
| `js/ui/dom.js` | `menu()` (§4.3); `tpl(template, parts)` → `DocumentFragment`, each `{name}` filled by a string or a Node; `rovingKeys(el, items, onMove)`, shared by `segmented`, the radio chips and the tablist; `trapFocus` accepting several roots |
| `js/ui/modes.js` (new) | the status stack and the `ui.modes` API (§4.4) |
| `js/ui/explore.js` (new) | the Explore tab (code moved, plus two cards) |
| `js/ui/layers.js` | `where` per item, group-by-view, `mountDisplay` (with Sky conditions, Quality, Comfort, App, the About host), Reset layers, `BORTLE_NAMES` |
| `js/ui/location.js` | the "In the sky" section |
| `js/ui/timebar.js` | the Time popover, `ui.openTime`, step-unit labels, the zone span and chevron |
| `js/ui/icons.js` | `tools`; delete `lock`, `unlock` |
| `js/app/actions.js` | `ui.scope` in `telescope`; `leaveTelescope`; the clearing rules; the boot rule |
| `js/core/store.js` | `PANELS = ['sky','details','events','explore','display']`; `PANEL_ALIASES`; `DEFAULT_STATE.ui.scope = null` |
| `js/core/url-state.js` | `tab=` validates against `PANELS ∪ keys(PANEL_ALIASES)` and returns `{panel, reveal?}` |
| `js/core/prefs.js` | `PREF_KEYS` + `uiVersion` |

### 8.2 Rewrite or shrink

- `view-switch.js`: the segment with Map, the three menus, the share flow (kept), the fade (kept).
- `shortcuts.js` `onEscape`.
- `sky-tools.js` and `expose.js`: logic kept, buttons and pills moved into modes; `EXPOSE_PRESETS`, `exposeStatusText` and `canPointAtSky` stay exported.
- `toast.js`: `mountFlash` goes to modes.
- `shell.js`: five TABS, the nav, the strip removal, the sheet math, the raise rule, `reveal`, the handle fix, scroll reset, toasts, trap, hint removal.
- `sky-now.js`, `sky-dome.js`, `tonight.js`, `body-card.js`, `year-planner.js`, `events-panel.js`, `about.js`, `help.js`, `topbar.js`, `eclipse-hud.js`, `coach.js`, `video.js`.
- `index.html`: root order swap.
- `css/app.css`.

### 8.3 Delete

- `js/ui/settings.js`, whose content moves to `layers.js`, `timebar.js` and `view-switch.js`.
- The symbols listed in §6.
- Run `npm run preload` after modules are added or removed. `repo.importmap.test` enforces it.

### 8.4 Hard rules (CLAUDE.md) this plan keeps

- `js/ui` never imports `three` or `js/render`. The telescope state lives in `js/app/actions.js`.
- URLs stay relative.
- No per-frame allocation, and no layout reads in rAF: menus and popovers measure only on open; the status stack and Charts use ResizeObserver; the scope fov check runs on the 4 Hz readout.
- The text mode still loads the UI without WebGL. Every new module is plain DOM.

---

## 9. Visual system

### 9.1 Tokens (`:root`, CSS section 1)

| Token | Value | Use |
|---|---|---|
| `--fs-1` | 11px | eyebrow (group titles only), captions, kbd, codes (C2) |
| `--fs-2` | 12px | meta, hints, notes, menu details, tab labels |
| `--fs-3` | 13.5px | body, rows, buttons, menu names |
| `--fs-4` | 16px | card and dialog titles, the date stamp |
| `--fs-5` | 20px | the selected body's name, HUD countdown, phone time |
| `--fw-1` / `--fw-2` / `--fw-3` | 400 / 600 / 750 | text / labels and buttons / names, titles and the selected state |
| `--sp-1…5` | 4 / 8 / 12 / 16 / 24 px | every gap, padding and margin |
| `--r-s` / `--r-m` / `--r-l` / `--r-pill` | 8 / 12 / 16 / 999 px | controls / cards, menus and popovers / panel, sheet and dialogs / chips, badges and segments. `--r-1` and `--r-2` stay as aliases until migrated. |
| `--h-ctl` | 36px fine, 44px coarse | buttons, segments, selects, inputs |
| `--h-chip` | 30px fine, 44px coarse | chips, icon buttons in rows |
| `--nav-h` | `calc(56px + var(--safe-b))` | phone tab bar |
| `--surface-solid` | `rgb(9,13,21)` | the tab bar and sticky heads (never translucent) |

**Rule:** every `font-size`, `font-weight`, `gap`, `padding`, `margin` and `border-radius` literal becomes a token. Today's CSS has 19 sizes, 9 weights, 17 letter-spacings, 26 radii and 17 gaps. `letter-spacing` is 0 everywhere except the eyebrow (`.08em`) and `--fs-5` (`−.01em`). Canvas-drawn text is exempt.

### 9.2 Type roles and headings

- **Eyebrow** (uppercase, `--fs-1`/`--fw-2`, `.08em`, `--muted`) is used **only** for group titles in panels, menus and popovers, and for month headers. Everything else that is eyebrow-styled today goes sentence case:
  - fact labels;
  - "Next up";
  - "Tip 1 of 3";
  - "Eclipse companion";
  - the verdict and "Approximate", which become badges;
  - "Online results", which stays a group title and so remains an eyebrow.
- **Headings:**
  - Tab panels use a visually hidden h2.
  - Groups use an h3 eyebrow.
  - Cards and dialogs use `--fs-4`/`--fw-3`.
  - Events' big sentence-case h2s go.
- **Help text:** one class, `.note` (`--fs-2`/400 `--muted`, at most two lines in panels; anything longer goes inside an ⓘ `<details>`). It absorbs `.pop__hint`, `.setting__hint`, `.dome__hint`, `.tonight__legend`, `.pal-note` and `.prose--muted`. `.prose` stays only for About text.

### 9.3 Components

- **`.chip`** (interactive, `--h-chip`, `--r-pill`) and **`.badge`** (status, 20 px, sentence case, 4 tones: `ok`, `accent`, `warn`, `muted`).
  - `.chip` absorbs `.chip--filter` and `.chip--quick`.
  - `.badge` absorbs `.pill`, `.live-pill` (a badge with a dot), `.status-dot` and the 9 badge modifiers.
  - `.bchip` survives only for the Details empty-state grid. `.echip` keeps its own geometry as a modifier. `.loc-chip` stays the top-bar component.
- **Buttons:**
  - `btn--primary` (filled accent): at most one per surface — Play, Go, Start, Next-up Jump, Show my sky.
  - `btn--soft`: secondary actions, with Details › Look at it as soft-accent.
  - `btn--ghost`: tertiary actions and icon buttons in rows.
  - `btn--danger-ghost`: Reset all settings.
- **Menu row:** `.vmenu__item`, the one row pattern for every menu.
- **Mode chip:** `.mode`.
- **No cards inside cards.** Inside a card or panel, subsections are groups separated by a 1 px `--line` rule or by `<details>`.
  - Top-level cards are Charts, Two places, Next up, tour cards and the Explore place cards.
  - Light time, the planner, the eyepiece and passes become sections.

### 9.4 Which control for which kind of choice (P11)

| Kind of choice | Control | Examples |
|---|---|---|
| A persistent on/off in a panel | switch row | layers, Night vision, 24-hour clock, Path, Where it's up |
| One of 2–5 short options | segmented radiogroup | Globe \| Sky \| Map, Quality, Aurora, Time runs, Show times in, Playback, Charts, dome orientation, postcard and video presets |
| One of 6+ options | native select | Step buttons move by (6), Light pollution (11) |
| A filter over a list | wrapping radio chips | Event filters |
| On/off or one of N inside a menu | `menuitemcheckbox` (✓) / `menuitemradio` (●) | Turn with the Earth, Night vision, Fullscreen / Look from, Follow |
| A mode you enter and leave | a pressed button or menu checkbox **and** a mode chip with Exit | Telescope, Follow, Ruler, Point, Exposure, Loop, viewpoints, Map |
| A one-shot action | a button with a verb | Look at it, Jump to it, Share link, Reset the view |
| A small form | non-modal popover dialog | Time |
| A task that takes over | modal dialog | Search, Postcard, Video, Help |
| **Never** | a control that cycles through hidden states | the tz chip and the track icon are deleted (K keeps its cycle, with a flash naming the state) |

### 9.5 States and targets

- **Selected states never rely on colour alone** (A4; night vision turns colour into brightness):

  | Control | Second cue |
  |---|---|
  | Active tab | `--fw-3` plus the 2 px ink bar |
  | Checked segment | fill plus `--fw-3` plus a 1 px inset `--line-2` ring |
  | Switch | knob position (already) |
  | Menu radio / checkbox | ● / ✓ glyph |
  | Pressed toggle (Telescope, Follow) | fill plus a ✓ icon before the label |
  | Radio chip | fill plus a ✓ icon |
  | Tools button with an active state | the 6 px dot |

- **Coarse targets.** Under `body.is-coarse` every interactive element is at least 44×44 px: `.btn`, `.icon-btn`, `.chip`, `.seg__btn`, `.tab`, `.vmenu__item` (52 px rows), `select`, `.switch-row`, `summary`, Eclipse HUD buttons, About links as 44 px rows, the sheet handle hit area, and the mode-chip buttons.
- **Globe labels** get a transparent padding hit slop to 32 px minimum. This is CSS only, in `#labels-root .lbl`.

---

## 10. Migration notes

### 10.1 URL keys

- No key changes.
- `tab=` is read and never written. It accepts the five `PANELS` and the aliases in §7.4 #136. An alias is never reported as invalid.
- `lock` and `trk` keep their meaning under the new names.
- `ui.scope` is never in the URL.

### 10.2 Store and prefs

- `PANELS = ['sky','details','events','explore','display']`. `PANEL_ALIASES = {layers: ['display'], settings: ['display','conditions'], about: ['display','about']}`.
- `DEFAULT_STATE.ui.scope = null`. `ui.panel` is not persisted, so it needs no migration.
- **Prefs:**
  - `skyDome` gains `chart: 'dome' | 'tonight'`.
  - On first load with `chart` unset:
    - `tonightOpen === true` and `skyDome.open !== true` gives `{open: true, chart: 'tonight'}`;
    - otherwise `chart: 'dome'`, keeping `skyDome.open`.
  - `tonightOpen` stays in `PREF_KEYS` for one release so it can still be read, then goes.
  - New `uiVersion` (number) drives the "what moved" toast.
  - `display`, `layers`, `quality`, `coachSeen`, `introSeen`, `installHint` and `recentPlaces` are unchanged.
- **Reset all settings** leaves `uiVersion` as it is, so the toast does not come back. It still resets the display prefs whose controls moved out of the old Settings tab (`tzMode`, `hour12`, `skyDark`, `aurora`, `red`), as today.

### 10.3 Coach targets

- Keep `#labels-root .lbl--body[data-id]`, `.ui .tabpanel--sky .body-row[data-id]`, `.ui .tb-scrub` and `.ui .seg--view`.
- Delete `.ui .strip .bchip[data-id]` (`coach.js:133`). Update `test/ui.coach.test.mjs` if it lists the selectors.

### 10.4 Label occluders

`render/labels.js:66` `OCCLUDER_SELECTOR` becomes:

```
.ui .topbar > *, .ui .viewbar > *, .ui .timebar, .ui .panel, .ui .sheet, .ui .navbar, .ui .status-stack > *, .ui .ecl
```

Otherwise beam labels slide under the phone tab bar and the chips.

### 10.5 CSS section 22 and `test/ui.a11y-css.test.mjs`

- **Add** to the forced-colours, more-contrast and reduced-transparency blocks:
  - `.navbar`, `.navbar .tab[aria-selected="true"]`;
  - `.vmenu__item[aria-checked="true"]`;
  - `.mode`, `.status-stack`;
  - `.chip[role="radio"][aria-checked="true"]`;
  - `button[aria-pressed="true"]`;
  - `.seg__btn[aria-checked="true"]` (the inset ring);
  - `details > summary`;
  - `.pop-time`, `.charts`.
- **Keep** the grouped selectors the test regexes match: `.glass, .chip, .bchip, .seg` (`:71`) and `.chip, .bchip, .echip, .btn, .seg` (`:77`), plus `.switch-row[aria-checked="true"] .switch`, `.seg .seg__btn[aria-checked="true"]` and `.tb-scrub__knob`. `.bchip` stays as a class.

### 10.6 Tests and smoke

**Update:**
- `test/core.url-state.test.mjs:579-581`: the PANELS list and the alias cases. `:592-598`, "the shell mounts exactly the PANELS tabs", passes once `TABS` has five ids.
- `test/ui.sky-now.test.mjs`: the `skyDarknessText` copy.
- `test/ui.location.test.mjs`: Esc, the examples and the footer, where pinned.
- `test/ui.coach.test.mjs`: the selectors.
- `test/ui.night-vision.test.mjs`: keep `SHORTCUTS`'s Shift+N row and `ui.flash`.
- `test/core.prefs.test.mjs`: `uiVersion`, `skyDome.chart`.
- `test/core.store.test.mjs`: `ui.scope`.

**New (pure, no DOM):**
- `test/ui.modes.test.mjs`: LIFO order, the exposure guard, `flash` after the chips;
- `test/ui.layers.test.mjs`: every layer has `where`; none is listed twice; every key in `LAYER_CODES` appears;
- `test/app.actions.test.mjs` additions: `telescope` → `leaveTelescope` restores the fov and track; scope clears on select and on view change;
- the sky-search ranker (fold, prefix before substring, the nine bodies before extras);
- `tpl()`.

**Smoke (`scripts/smoke.mjs`):**
- "sel= opens Details" (`#tab-details[aria-selected=true]`, `:593-595`) is kept.
- The phone date clip check (`.tb-date .stamp__day, .stamp__time`, `:608`) is kept; the new zone span sits beside them.
- Add one check that `.vb-tools`, `.vb-share` and `.vb-more` exist with WebGL.
- Add one phone `--mobile` check that `.navbar [role=tab]` is visible at peek.

**Goldens and preload:**
- Re-render the text-mode structure golden (CI goldens job). The pixel goldens hide the DOM and are unaffected.
- Run `npm run preload` for `modes.js` and `explore.js`, and for the removal of `settings.js`.

### 10.7 Docs and assets

- README: the shortcut table (Esc, Mouse, renames) and the feature table.
- `docs/ARCHITECTURE.md`: the UI module map (`modes.js`, `explore.js`, Display in `layers.js`, `settings.js` gone) and §12 (section 22).
- Regenerate the manifest screenshots (`assets/screenshots/*.jpg`) with the PWA commit's commands.
- `docs/ROADMAP.md` and `graphify-out/` are not touched by this work.

### 10.8 i18n hand-off

- Every new or changed string is a whole phrase with `{placeholders}`. Plurals are separate strings (`'{n} more event shown'` / `'{n} more events shown'`).
- Fragment builders fixed: `sky-now.js:143`, `timebar.js:282, :286, :304`.
- New strings number about 70: menu names and details, mode-chip templates, Time popover labels, the Explore cards, Display group titles, ⓘ and "What these numbers mean" entries, Mouse rows, HUD contact names, and the toast. About 40 are deleted: Settings duplicates, About's buttons, card heads and legends, the triple offline message, the per-row Jump labels.
- Tab labels stay ≤ 8 characters in English. The Vietnamese sweep should get a short-label column for the tab bar.

---

## 11. Bytes (raw, JS + CSS; every tier pays them)

The baseline today: medium 5.83 of 5.97 MB (hard line 6.0), low 5.07 of 5.20 MB.

| Change | Δ raw (KB) |
|---|---:|
| Body strip, JS + CSS | −5.1 |
| Four menu builders and the expose popover → `menu()`; 8 toolbar buttons and their sync | −3.0 |
| Four status pills + flash slot → `modes.js` (JS −2.1, CSS −2.7), plus the new module +2.0 | −2.8 |
| `settings.js` deleted (−10.4) → Display sections in `layers.js` (+6.5) and moved rows | −3.9 |
| Time bar: tz chip/cycle, tools row, 2 popover scaffolds → 1, plus sections, legend, unit labels | −1.0 |
| Topbar search button; About's help button; `helpButton` | −0.9 |
| Dome/Tonight card chrome → one Charts host | −0.8 |
| Up/Down badges, Details head badge and tonight box | −0.7 |
| CSS tokens and merges (help classes 7 → 1, pills → chip/badge), minus new nav, menus, coarse block | −2.0 |
| `modes`-driven Esc in `shortcuts.js`; pick-hint listener | −0.6 |
| Display: `where` grouping, other-view details, Reset layers, About host, reveal | +2.2 |
| Explore module (boilerplate, two cards, Show all) | +1.6 |
| Events: window, Show the rest, row buttons, radiogroup | +0.6 |
| Details: action row + More, switch rows, disclosures, empty-state search | +1.3 |
| Telescope state and clearing rules (app + UI) | +1.0 |
| Search › In the sky | +2.0 |
| Shell: nav, raise rule, reveal, handle fix, trap roots, toast clamp, tablet cap | +1.2 |
| Help Mouse group, generated layer rows; HUD copy and collapse; coach; what-moved toast; `tools` icon | +1.6 |
| `dom.js`: `tpl`, `rovingKeys` | +0.6 |
| **Net** | **≈ −8.7 (realistic range −12 to +4)** |

Measure with `npm run size` after every chunk. Chunks 1–3 must each leave the cumulative net ≤ 0. The planning target for the whole redesign is ≤ −3 KB, and the ceiling is **+15 KB raw net**.

If a chunk lands above its estimate by more than 4 KB, cut in this order:
1. Shorten the rewritten modules' JSDoc to the new behaviour (raw bytes include comments).
2. Drop the time-bar legend.
3. Drop Explore's "Show all", showing everything.
4. Drop the what-moved toast.

---

## 12. Owner decisions (not implemented by default)

1. **A phone tap on the globe moves the observer** (M11, SPEC F.2, `js/ui/index.js:666-671`). A near-miss on a label teleports you (Undo lasts 8 s).
   - Recommendation: on coarse pointers, a tap within 24 px of a body label selects that body instead of moving. Long-press to move is the stronger alternative.
   - This lives in `js/app` picking, not the UI, and is **not** in the chunks below until the owner decides.
2. **About folds into Display and Settings disappears as a tab.** The mitigations are the ⋯ "About, credits and help" item, the `tab=settings`/`tab=about` aliases and the one-time toast. The fallback, if feedback objects, is a sixth "Settings" tab holding Display's Quality, Comfort, About and App sections. It is the same code with a different host.
3. **The phone body strip is removed.** The fallback, if feedback objects, is to put it back inside the Up now head (not the sheet head), at no chrome cost.
4. **Version 2.1.0** in `js/version.js` and `package.json` belongs to the release commit (the SW VERSION test ties them).

---

## 13. Implementation chunks

Each chunk is one or more commits that leave the app working. Before merging each one, run all of:

```
npm test
npm run smoke
npm run smoke:mobile
node scripts/smoke.mjs --offline --expect-ready --assert --no-webgl
npm run size
```

Then check the screenshots listed under the chunk. Each chunk removes an old control in the same commit that adds its new home, so no feature is ever unreachable in between.

### Chunk 1: Modes, menus and the toolbar

**Scope** (§4.2–4.4, §5.1, §4.12, parts of §4.1 and §4.6):
- Add the tokens to `:root`; new components use them only.
- Add `menu()`, `tpl()` and `rovingKeys` to `dom.js`.
- Add `modes.js`. The vantage caption, the ruler and aim pills, the exposure pill, the pick hint and the flash render as mode chips. Add the `map` chip.
- `actions.js`: `ui.scope`, `leaveTelescope`, the clearing rules and the boot rule.
- `onEscape` uses `ui.modes.exitTop()`, with the exposure guard.
- Rewrite `view-switch.js`:
  - `[Globe | Sky | Map] [Tools ▾] [Share ▾] [⋯]`, with all Tools contents, including the long-exposure items. Delete the expose popover.
  - Share becomes `role=menu`. ⋯ shows on every layout; "About, credits and help" opens the About tab until Chunk 3.
  - The phone column gets captions and 44 px `flex-shrink: 0` buttons.
- Delete the eight old toolbar buttons, the vantage menu and `mountMoreMenu`.
- Delete Settings' "Lock view to Earth" row.
- Renames: Turn with the Earth, Follow, A night of turning stars, the K/L flashes.
- Help: the Mouse group and the Esc, Home, H and step rows.
- Fixes:
  - Search closes on one Esc;
  - unique brand gradient id;
  - `#ui-root` before `#labels-root`;
  - the sheet handle mouse click (deferred pointer capture);
  - `.sheet__body` scroll reset;
  - solid sticky tab background;
  - toast clamp at full.
- `OCCLUDER_SELECTOR` gains `.status-stack > *` and `.ecl`.
- `npm run preload`; new `test/ui.modes.test.mjs`; actions tests for the telescope.
- Files: `dom.js`, `modes.js`, `view-switch.js`, `sky-tools.js`, `expose.js`, `toast.js`, `shortcuts.js`, `help.js`, `location.js`, `topbar.js`, `shell.js`, `settings.js`, `video.js`, `icons.js`, `index.js`, `js/app/actions.js`, `index.html`, `render/labels.js`, `css/app.css`, tests.

**Acceptance:**
- At 1440×900, Globe, Sky and Map views show the same four labelled toolbar controls in the same places. Screenshots: `c1-d1440-globe.png`, `c1-d1440-sky-jupiter.png`, `c1-d1440-map.png`.
- In the map, L1 and solar-system views, a view segment is checked: Map in the map view, Globe in the others.
- **Tools menu.**
  - Globe view: the Look from radios, Turn with the Earth, Reset the view and Sky view tools…
  - Sky view: the Follow radios, Telescope, Angle ruler, the long-exposure items and Reset the view.
  - Every row shows a name, a detail line and its kbd on fine pointers.
  - Screenshots: `c1-d1440-tools-globe.png`, `c1-d1440-tools-sky.png`.
- Share and ⋯ are `role=menu`. Opening either by keyboard focuses the first item, and Esc returns focus to its button (A2).
- **Esc matrix (§5.1), verified by script**, logging `{sel, scope, track, expose, range, mode}` after each press:
  - telescope → the first Esc restores the field and keeps the selection;
  - exposure with frames → the first Esc warns, the second stops;
  - loop → stops;
  - follow → stops;
  - map → globe;
  - Search with text → closes in one press.
- With the ruler active, pressing C shows the flash under the ruler chip, not over it. Screenshot: `c1-d1440-ruler-flash.png`.
- The telescope chip shows "Telescope on Jupiter · {fov}° field, followed" with a working "Leave the telescope". Screenshot: `c1-d1440-telescope-chip.png`.
- The first Tab stop is the skip link, and no canvas label comes before the location chip.
- On an 800×900 window with a mouse, clicking the sheet handle changes the snap.
- On the phone (390×664 @3), the floating column buttons are ≥ 44×44 with captions. Screenshot: `c1-p-peek.png`.
- Every keyboard shortcut in `SHORTCUTS` still works (scripted keypress pass).
- `npm run size`: cumulative net ≤ 0 KB raw against `40131ce` (estimate −7 KB).

### Chunk 2: One Time popover

**Scope** (§4.5):
- Build the Time popover: Go to, Stepping (select, modifier hint, Time runs, phone step buttons), Loop `<details>`, Show times in (segmented + 24-hour switch), and What the time bar shows.
- Add `ui.openTime(section)`. The `loop` chip's Edit opens it.
- Delete from the bar: `unitSel` and its 940 px `display:none`, `btnReverse`, `lapseBtn`, `tzChip` and its cycle, `toolsEl` with the mobile `arrange` branch, and the separate date and lapse popovers.
- Step buttons show the unit, with the two-line tooltip.
- The date button gets the zone span and chevron, and the new accessible name.
- The rate readout gets its paused and loop states and the Slower tooltip.
- Delete Settings' Show times in and 24-hour rows.
- `shell.js`: `measureSheet`/`setSnap` lose `toolsEl`.
- Renames: Back and forth, Loop, Sidereal day (23 h 56 min).
- Fix the fragment strings at `timebar.js:282/286/304` with `tpl()`.

**Acceptance:**
- At 1280×720 and 1000×700, every step unit (minute → year, sidereal day) is reachable by pointer through the Time popover, and no time control is `display:none`. Screenshots: `c2-d1280-globe.png`, `c2-d1280-time-popover.png`.
- The date button reads "…· Greenwich, UTC+0 ▾" in Observer mode and "… · UTC ▾" in UTC mode.
- Opening the popover from the date button focuses the date input. Esc returns focus to the date button.
- R, `,`, `.`, Shift/Alt variants, `[` `]`, N and Space behave as before. Time runs Forward/Backward stays in sync with R.
- A loop started from the popover shows the `loop` chip. Esc stops it, and the readout returns from "Loop" to the rate.
- While paused, the rate readout is muted and its accessible name ends with "paused".
- **Phone at peek:** the sheet head is the handle plus a two-row time bar (no tools row, no strip yet), and the stamp shows a chevron. Screenshots: `c2-p-peek.png`, `c2-p-time-popover.png`.
- Text mode: the time bar has play, date, speed and Now, and the popover works. Screenshot: `c2-text-time.png`.
- `npm run size`: cumulative net ≤ 0 KB (estimate −8 KB).

### Chunk 3: Five tabs, Explore, Display and the phone tab bar

**Scope** (§3, §4.6, §4.9–4.11, §4.13 toast and coach, §10.1–10.4):
- **Tabs and routing:**
  - `TABS`: Up now, Details, Events, Explore, Display, with the new icons.
  - `PANELS` and `PANEL_ALIASES`; `tab=` aliases; `openPanel(..., {reveal})`.
  - The rail shows icon and label.
- **Explore:** the new `explore.js`, moving tours, born under, moments and comets out of `events-panel.js`, plus the Two places and Stand on Mars cards. Delete the palette's Compare and Mars footer buttons.
- **Events:** the 8-week window plus "Show the rest", row buttons, the radiogroup filters, no h2s or pills.
- **Display** (`mountDisplay` in `layers.js`):
  - layers grouped by the current view with `where`, the "Only in …" group and Reset layers;
  - Sky conditions (Aurora segmented), Quality, Comfort, App;
  - the About host: `about.js` moved, Report a problem moved up, its help button deleted.
- Delete `settings.js` and the About tab.
- Layer label renames in `LAYER_GROUPS` and `actions.js` `LAYER_LABELS`; Help's Layers rows generated.
- ⋯ "About, credits and help" reveals About.
- **Phone:**
  - `nav.navbar` holding the moved tablist;
  - the strip deleted (`mountBodyStrip`, CSS, shell, coach selector);
  - the new `measureSheet`; the raise-to-half rule on `'labels'`/`'click'` sources;
  - the column shows only the view segment above peek;
  - the focus trap covers the sheet and nav;
  - the tablet portrait sheet and nav cap at 560 px, anchored left.
- Text-mode trims for Explore and Display.
- The what-moved toast and `uiVersion`.
- `OCCLUDER_SELECTOR` gains `.navbar`.
- `npm run preload`. Update the url-state, coach and prefs tests. Add `test/ui.layers.test.mjs`. Add the smoke checks for `.vb-*` and the visible tab bar.

**Acceptance:**
- At 1440×900, the Events tab's `scrollHeight` (All filter) is ≤ 3,000 px, and it has ≤ 60 focusable controls. Screenshot: `c3-d1440-events.png`.
- Explore shows The sky you were born under within the first 900 px. Screenshot: `c3-d1440-explore.png`.
- **Display:**
  - In globe view it lists no sky-only layer outside the closed "Only in Sky view" group; in Sky view the reverse.
  - Every one of the 25 layer keys is present exactly once.
  - Screenshots: `c3-d1440-display-globe.png`, `c3-d1440-display-sky.png`.
- **URL aliases:**
  - `#tab=settings` opens Display at Sky conditions;
  - `#tab=about` opens Display with About expanded;
  - `#tab=layers` opens Display;
  - `#tab=explore` opens Explore;
  - `#tab=events` (the manifest shortcut) still works.
- Every inventory row in §7 that names Explore, Display or ⋯ is reachable, checked by a script that clicks each route.
- **Phone 390×664:**
  - five labelled tabs are visible at peek, half and full;
  - content at half is ≥ 190 px;
  - tapping a globe label at peek opens Details at half with the name visible;
  - switching tabs starts each at its top.
  - Screenshots: `c3-p-peek.png`, `c3-p-half-sky.png`, `c3-p-label-tap.png`, `c3-p-full-display.png`.
- Tablet 820×1180 coarse: the sheet is ≤ 560 px wide and the globe is visible beside it. Screenshot: `c3-t-half.png`.
- The coach runs all three steps on phone and desktop first run. Screenshots: `c3-p-coach-0.png`, `c3-d-coach-2.png`.
- **Text mode:** five tabs render; Display shows Sky conditions, Comfort, About and App only; ⋯ offers shortcuts, Night vision and About. Screenshot: `c3-text-full.png`.
- A returning user (`introSeen`, no `uiVersion`) sees the what-moved toast once.
- `npm run size`: cumulative net ≤ 0 KB (estimate −12 KB).

### Chunk 4: Content, sky search and the visual system

**Scope** (§4.1 search, §4.7, §4.8, §4.13 HUD, §9, §10.5–10.7):
- **Up now:**
  - the plain-words summary with ⓘ and the Change link;
  - the list first and the Charts card (Sky dome | Tonight; the card heads deleted; the hidden chart gated);
  - the badges removed; the tip variants;
  - the `skyDome.chart` pref and the `tonightOpen` migration;
  - the "Mirrored" rename.
- **Details:**
  - the action row (Look at it, Telescope, Follow, More ▾) and the switch rows (Path, Where it's up, Sun paths);
  - the verdict merged; facts before the extras; More positions and What these numbers mean (the `title=` hints deleted);
  - "Leo (Leo)" fixed; the renames; the empty-state search button.
- **Search:** In the sky (the index, ranking, rows, select plus raise), the placeholder and hint, one offline message.
- **Eclipse HUD:** the copy, the contact sub-labels, auto-collapse on phone, 44 px buttons.
- **CSS sweep:**
  - literals → tokens;
  - help classes merged into `.note`; pill variants merged into chip and badge;
  - the eyebrow rule; no cards in cards;
  - non-colour selected cues; the coarse 44 px block;
  - section 22 additions.
- Re-render the text-mode golden. README and ARCHITECTURE updates. Manifest screenshots.

**Acceptance:**
- At 1280×720 the first Up now body row is visible without scrolling, and all nine rows fit on the first screen with Charts closed. Screenshot: `c4-d1280-upnow.png`.
- Up now says sunset and sunrise once, shows no Up/Down badge, and reads "City sky: stars to magnitude 3.6 (Bortle 9)" at Greenwich by night.
- **Details for Jupiter:**
  - the name, verdict and the four-button action row sit within the first 200 px of the tab;
  - the constellation appears once;
  - Path and "Where it's up" are `role=switch` and stay in sync with Display and T/O;
  - Telescope shows `aria-pressed=true` while the chip is up.
  - Screenshots: `c4-d1440-details-jupiter.png`, `c4-p-half-details.png`.
- Search finds "Sirius", "ISS", "Halley", "M31" and "Jupiter" in an "In the sky" section, and choosing one selects it and opens Details. "Tokyo" still finds the place. Screenshot: `c4-d1440-search-sirius.png`.
- **Eclipse HUD:** at Luxor (`#t=2027-08-02T10:30:00Z&loc=25.69,32.64&n=Luxor&intro=0`) it reads "Jump to just before totality". On phone it collapses to one line at half and in Sky view. Screenshots: `c4-d1440-eclipse.png`, `c4-p-eclipse-half.png`.
- The CSS declares at most 7 distinct `font-size` values (the 5 tokens plus the canvas and stamp exemptions), 3 `font-weight` values and 5 radii (4 tokens plus 50 %). Check: `grep` on `css/app.css`.
- **Coarse targets:** on the phone and on tablet landscape (1180×820 coarse), a script lists 0 visible interactive elements under 44×44 px (globe labels excepted at 32 px).
- **Media:** `--media=forced-colors:active`, `prefers-contrast: more`, `prefers-reduced-transparency` and `--reduced-motion` screenshots show the selected tab, segment, menu item and pressed toggle distinguishable without colour. Night vision likewise. Screenshots: `c4-d-media-fc.png`, `c4-d-night.png`.
- `test/ui.a11y-css.test.mjs` passes. The text-mode golden is re-rendered and committed.
- **Final `npm run size`:** medium ≤ 5.97 MB, low ≤ 5.20 MB, redesign net ≤ +15 KB raw (target ≤ −3 KB, estimate −9 KB).

---

## 14. Acceptance criteria for the whole redesign

1. **Nothing is lost.** Every row of §7 has a working new route, verified by a script that exercises each one at 1440×900, on the phone and in text mode (where applicable).
2. **No hidden controls.** No interactive control is `display:none` because of width alone, at 900–1920 px desktop widths and 360–430 px phone widths.
3. **Words.** The floating chrome (toolbar, time bar, top bar, phone column) has at most four icon-only controls: play/pause, ⋯, and the calendar and × inside labelled rows. Each has an accessible name and a tooltip.
4. **Modes.** Every state in §4.4 shows a chip with an Exit. Esc unwinds them newest first before it deselects. The flash never overlaps a chip.
5. **Density.**
   - Events ≤ 3,000 px at 1440×900.
   - Display ≤ 1.6 screens at 1440×900 in either view, with the "Only in…" and About groups closed.
   - Phone content at half ≥ 190 px.
   - The first Up now row visible at 1280×720.
6. **Keyboard.** Every shortcut from `SHORTCUTS` works. The skip link is the first Tab stop. Menus, the Time popover and dialogs move focus in and return it.
7. **Patterns.** Every choice follows §9.4. No hidden cycles remain except the K key.
8. **Text mode.** `smoke --no-webgl` passes. All five tabs and ⋯ work; nothing in them refers to the 3D view.
9. **Hard rules.** `npm test` (including the import-boundary, no-external-URL and preload tests), both smokes and the perf gates pass. There are no layout reads in rAF and no per-frame allocation.
10. **Budget.** Net ≤ +15 KB raw (target ≤ −3 KB); medium and low stay within their budgets.
11. **i18n readiness.** No new user-visible string is built by concatenating fragments. Every template has named placeholders.

---

## 15. Deviations

Where the spec was wrong in practice, or a detail had to be decided while building, the chunk did
the right thing and records it here.

### Chunk 1 (modes, menus and the toolbar)

- **Telescope.**
  - The zoom-out rule (`max(10°, 3 × fovDeg)`) only counts once the zoom-in has arrived. The
    telescope starts from the current field (often 60–70°) and eases in, so a 4 Hz check during
    the ease ended the scope at once.
  - `leaveTelescope()` restores a free look's field with `rig.setMode('sky', {look: {…, fovDeg}})`.
    `rig.telescope(fov)` only sets the field the next tracking engage zooms to, so it is used only
    when the telescope found Follow on.
  - The chip shows the telescope's framing (`ui.scope.fovDeg`), not the live field: the live field
    would need `actions.getView()`, which reads the canvas size (a layout read) on every readout.
  - "Follow set to Look around freely" is checked as a state (no following while a scope is up)
    on any change of selection, view or Follow, which has the same effect as the transition.
- **Mode chips.**
  - The loop chip has no Edit action yet: it opens Time › Loop, which arrives with the Time
    popover in chunk 2.
  - The chips do not announce themselves: the actions already say "Telescope on Jupiter.",
    "Following the stars…", "Loop started." and so on, and a second announcement would collide in
    the announcer's 2 s throttle. Picking a place announces from `shell.js`, because the old hint
    was a live region.
  - Text mode shows the stack (§3.4 said only the flash), because loops run without WebGL and
    Esc stops them. There it sits in the flow under the top bar (sticky), and the flash floats.
  - The phone's "+{n} more" chip reads "Show fewer" while the stack is unfolded.
- **Menus.**
  - Items need no `id`. An item may instead be `{note}`, a line of text: the long-exposure group
    keeps the deleted popover's "Low quality stacks without the glow (bloom)." that way.
  - Telescope on {name} is a `menuitemcheckbox` inside the Follow group, as the mock-up draws it.
  - Turn with the Earth is hidden while a viewpoint or the solar system is shown, where it does
    nothing (as the old lock button was).
  - Rows show a kbd only where a key exists (the Look from radios have none).
- **Toolbar.** On desktop `.viewbar` spans the canvas (right-aligned, the bar itself
  `pointer-events: none`) and is the `viewbar` container, because a query container needs a
  definite width. The labels hide under 560 px and the view labels under 420 px, as specified.
- **Deleted a chunk early, because ⋯ ships on every layout now** (R1, one home per control):
  `helpButton()` (§4.12) with its Settings and About copies, and Settings' Show interface tips
  (§4.11). Tips stay in ⋯ and the help foot; shortcuts in ⋯ and `?`.
- **Help.** The two step rows stay one key per row ("Step 1 day (or Shift with a step button)",
  "… sidereal day (or Alt …)") instead of one merged row. The `/` row keeps "Search places" until
  chunk 4 adds the sky.
- **Renamed early, to match the chips and menus:** the narrator's "Loop started." / "Loop
  stopped." (the time bar keeps "Timelapse" until chunk 2), the Details card's Track button
  (now Follow; chunk 4 rebuilds the row), the recorder's own preset label ("A night of turning
  stars"), and the skip link ("Skip to the sky list", §4.6, with the DOM-order fix).
- **Sheet handle.** Besides capturing only after the 4 px threshold, the drag's move and up
  listeners are on `window`, so a quick mouse drag from the handle's top edge, which leaves the
  sheet before the threshold, still drags.
- **Fixed on the way (pre-existing):** in text mode, `.ui[data-layout="text"] *` turned pointer
  events back on for the full-screen reduced-motion veil (`.fade-overlay`, z-index 60), so no click
  reached the page. The veil, and the text-mode stack, are now `pointer-events: none !important`.
- **Bytes.** Net −0.6 KB raw against `40131ce` (estimate −7 KB; medium 5,828,815 B, low
  5,071,915 B). `modes.js` is 6.7 KB, not 2 KB: it holds a DOM-free core for the tests, the loop
  chip and the phone's "+{n} more". `menu()` is about 3 KB. To stay under zero, the chunk also
  deleted seven icons nothing referenced (`fullscreen-exit`, `chevron-left`, `clock`, `panel`,
  `grid`, `signal`, `signal-off`) and shortened the rewritten modules' JSDoc.

### Chunk 2 (one Time popover)

- **The zone's place is the observer's name.** The zone uses `ui.placeShort`, which for the
  default observer is "Royal Observatory Greenwich", so the date button reads "… · Royal
  Observatory Greenwich, UTC+0 ▾" (and the Observer segment says the same). It fits a 1440-px
  window; when the bar is tighter (the Julian tag, the ⚠ badge, a long name) only the place
  ellipsizes, never the offset, and under a 940-px bar the short form "UTC+0" shows, as specified.
  The zone templates (`zoneTemplates`) are whole phrases; an approximate zone reads "{place},
  {offset} (approx.)" and "{offset} (approx.)".
- **Phone stamp.** Two lines as drawn (time and chevron, then "Sat 6 Feb 2027 · UTC+0"). At 390 px
  the day sometimes leaves no room for the zone ("Wed 11 Nov 2026"): the zone then wraps onto a
  clipped third line and disappears whole instead of showing "U…". The rate readout's minimum
  width on the phone went from 46 to 36 px to make that rare. The ⚠ badge stays in the phone row
  (icon only), and the body strip stays in the sheet head until chunk 3.
- **Phone step buttons.** They are the bar's own two buttons, moved into Time › Stepping by
  `arrange()` (one set of handlers, Shift and Alt included), labelled "Back 1 hour" and "Forward 1
  hour" there.
- **No time control hidden by width.** Besides `unitSel`'s 940-px rule, the bar also hid the step
  buttons under a 640-px bar (`.tb-back, .tb-fwd { display: none }`), which is what removed them
  at 1000×700 and in text mode on a phone. That rule is deleted too: a narrow bar drops only the
  unit text. A bar under 520 px (text mode on a phone) lets the stamp wrap inside the date button.
- **Tooltips.** The step buttons' tooltip keeps the key on its first line ("Back 1 hour ,") and the
  modifiers on the second (`data-tip2`, CSS `white-space: pre`).
- **Copy.** The Loop section's note is "Times are in {zone}." without "Loop the clock between two
  moments.", which its summary already says (R5). The Julian sentence is the mock-up's shorter
  one. "One loop takes {seconds} s" is one label around the number input.
- **What closes the popover.** Go, a quick jump, Start and Stop close it and return focus to the
  date button, as the two old popovers did; the step unit, Time runs, the zone and the 24-hour
  switch keep it open.
- **"Loop" in the readout** shows for every clock range (Play the eclipse and the analemma too), as
  "Timelapse" did; the `loop` chip still shows only for a range that is not the analemma's stride.
- **Announcement.** "Times in {zone}." is said by the popover's segment, not by `setTzMode`, so
  Reset all settings stays quiet.
- **Mars.** On desktop the zone gives way to the Sol stamp, as the zone chip did; on the phone the
  Sol stamp wraps to two lines so the chevron stays. The date button's name there is "Earth date
  and time: {stamp}, {zone}. On Mars: {sol}. Open the time panel".
- **Fixed on the way (pre-existing):** with the phone sheet at full, its focus trap pulled focus
  out of any popover (the old date popover too), so the date field could not be typed in. An open
  `.popover` now counts as inside `trapFocus` (two lines; chunk 3's several-roots change builds on it).
- **Deleted on the way:** the `reverse` icon (nothing uses it), the `.seg__opt` native-radio
  segment (Playback is now `segmented()`), the time bar's unused `is-live`/`is-paused` classes and
  the scrubber's unused id.
- **Popover size.** It is 456 px wide (four quick jumps on one row) with 8-px section gaps, so at
  1280×720 it fits above the date button (582 px tall); on shorter windows it overlaps the bar,
  as `openPopover` clamps it, and scrolls inside.
- **Bytes.** The chunk is −0.5 KB raw (estimate −1.0); the redesign is −1.1 KB against `40131ce`
  (medium 5,828,349 B, low 5,071,449 B; the −8 KB cumulative estimate assumed chunk 1's −7 KB). To
  get there the rewritten `timebar.js` JSDoc was shortened (§11, cut 1).

