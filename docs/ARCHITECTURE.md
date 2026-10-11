# Planet Location Marker architecture

Planet Location Marker is a static site with no build step. Browsers load the ES modules in `js/`
directly. three.js r170 and astronomy-engine 2.1.19 are vendored under `vendor/`, and the textures
and data ship in `assets/` and `data/`. Nothing is fetched from a CDN at run time, and nothing on the
critical path needs the network. The only optional network use is online place search, through
open-meteo, then Photon, then Nominatim.

This document is for contributors. It covers how the pieces fit, where state lives, what runs each
frame, and the contracts you must keep when you change something. The astronomy, meaning frames,
formulas and accuracy, is in [ASTRONOMY.md](ASTRONOMY.md).

---

## 1. Layers and the purity rules

```
index.html        import map · inline loader · feature detection · global error capture
└─ js/main.js     composition root: builds everything, wires it together, owns boot order
   ├─ js/core/    app state: store, bus, clock, url-state, prefs, tz, format, quality      PURE
   ├─ js/geo/     offline cities, online geocoder, lat/lon parsing                        PURE
   ├─ js/astro/   astronomy: frames, snapshot, almanac, events, paths, worker + client    PURE
   ├─ js/data/    star-catalog decoder                                                    PURE
   ├─ js/app/     actions (UI → app API), frame loop, label feed, intro, fallback         glue
   ├─ js/ui/      the DOM interface                         (dynamic import, never three)
   └─ js/render/  three.js scene modules  ┐                 (dynamic import)
      js/camera/  camera rig and picking  ┘
```

The rules are enforced by `test/repo.*.test.mjs`. They exist for concrete reasons.

| Rule | What | Why |
|---|---|---|
| R1 | `astro/`, `core/`, `geo/` and `data/` never import `three`, touch the DOM or use `window`. They reach astronomy-engine only through `js/astro/ae.js`, by relative path. (`core/prefs.js` may touch `globalThis.localStorage`, guarded.) | They run unchanged in Node tests and in the module worker. Import maps do not apply inside workers or Node. |
| R2 | Only `render/`, `camera/`, `main.js` and `app/` may import `three`. | Keeps the 3D engine swappable and the rest testable. |
| R3 | `ui/` never imports `three` or `render/`. It changes the app only through `store`, `clock` and `actions`. | Text mode needs the UI to work without WebGL or import maps. |
| R4 | All URLs are relative (`assets/…`, `data/…`). | The site is served from `/planet-location-marker/` on GitHub Pages. |
| R5 | No per-frame allocation of geometries, materials, textures or typed arrays. Use module-level scratch. | Steady memory. The smoke test checks it at 1 day/s. |
| R6 | Every custom `ShaderMaterial` fragment ends with the `tonemapping_fragment` and `colorspace_fragment` includes. | These are no-ops behind the composer and tone-map on the low-tier direct path. |
| R7 | Vectors in pure code are `Float64Array(3)`. 3×3 matrices are row-major `Float64Array(9)`. Matrices for three are column-major `Float64Array(16)`. | One convention, and no transposition bugs. |

`main.js` imports statically only modules that need neither three.js nor the import map. It loads
the UI and the render stack with literal `import('./…')` calls, so:

- a browser without import maps still gets a working interface (text mode);
- a broken UI module leaves the globe running;
- a broken render module leaves the panels running.

---

## 2. Module map

| Area | Module | Responsibility |
|---|---|---|
| Entry | `index.html` | Import map (`three`, `three/addons/`). `modulepreload` for three, astronomy-engine and `main.js`. Preload for `data/cities.json`. Inline loader. Classic scripts for error capture (`window.__pcLoader`) and feature detection (`window.__pcEnv`). |
| | `js/main.js` | Boot sequence, service wiring, store-to-module subscriptions, click picking, tier switching, the intro runner, `window.__app`. |
| App glue | `js/app/actions.js` | `createActions(deps)`: the only API the UI calls besides `store` and `clock`. Also `normalizeObserver` and `shadowPoint`. |
| | `js/app/loop.js` | `createLoop(deps)`: the frame loop with render-on-demand, guarded module calls and strikes, governor sampling and the 4 Hz readout. |
| | `js/app/labels-feed.js` | `buildAnchors(state, snap, catalog, trails)` and `createLabelsFeed(deps)`: label anchors with live vectors. |
| | `js/app/intro.js` | `playIntro(opts)`: the first-visit camera flight, pin drop and beam launch. |
| | `js/app/fallback.js` | Text-mode banner, context-lost overlay, fatal-error hand-off. |
| Core | `js/core/store.js` | Immutable slices, selector subscriptions, `DEFAULT_STATE`. |
| | `js/core/bus.js` | Fixed event types: `readout`, `toast`, `announce`, `almanac`, `events`, `intro`. |
| | `js/core/clock.js` | Simulated time: Live mode, the signed rate ladder, steps, log-time tweens, range loops, clamping to 1000–3000. |
| | `js/core/url-state.js` | `parseHash`, `serializeHash` and `bindUrl`, which keeps the URL hash in sync (throttled `replaceState`). |
| | `js/core/quality.js` | `TIERS`, `detectTier`, `tierConfig`, and `createGovernor` (downgrade only). |
| | `js/core/prefs.js` | `localStorage` under `pc2.`, falling back to memory. |
| | `js/core/tz.js`, `js/core/format.js` | Time zones (canonicalised, DST-safe) and every displayed number and string. |
| | `js/core/types.js` | JSDoc typedefs: the shared contract. |
| Geo | `js/geo/cities.js` | About 1,600 GeoNames cities. Fuzzy search, `nearest`, `byTz`. |
| | `js/geo/geocode.js` | Online providers with timeouts, a circuit breaker and an LRU cache. |
| | `js/geo/coords.js` | Parses decimal and DMS coordinates. |
| Astro | `js/astro/ae.js` | Re-exports astronomy-engine. |
| | `js/astro/bodies.js` | `BODIES`. Its order is a contract. |
| | `js/astro/frames.js` | The S mapping, Earth orientation, ENU, alt/az, matrix helpers. |
| | `js/astro/snapshot.js` | `computeSnapshot`: everything about one instant, into preallocated arrays. |
| | `js/astro/almanac.js`, `events.js`, `paths.js` | Rise/set, twilight, Tonight; events; retrograde paths. |
| | `js/astro/worker.js`, `client.js` | Module worker plus a Promise client with a main-thread fallback. |
| | `js/astro/shadow.js`, `photometry.js` | Eclipse disc overlap; B−V colour, refraction, airmass, exposure. |
| Data | `js/data/catalog.js` | Decodes `data/sky.json` into GPU-ready typed arrays in the scene frame. |
| Render | `js/render/context.js` | Renderer, scene, camera, tier switching, `invalidate`/`onInvalidate`, context loss, stats. |
| | `js/render/postfx.js` | Composer with bloom and the final pass. |
| | `js/render/textures.js` | Placeholder-first texture store with byte-weighted progress. |
| | `js/render/earth.js`, `atmosphere.js` | Earth shader (day, night lights, glint, twilight, clouds, eclipse shadow, footprint) and atmosphere. |
| | `js/render/sky.js`, `bodies.js`, `ground.js` | Stars, constellations, Milky Way and grids; Sun, planets and the true-scale Moon; sky-view dome and ground. |
| | `js/render/beams.js`, `pin.js`, `labels.js` | Signature beams, observer pin and horizon disc, DOM label pool. |
| | `js/render/trails.js`, `flare.js`, `debug.js` | Retrograde paths, lens flare, `?debug=1` overlay. |
| Camera | `js/camera/rig.js`, `picking.js` | Orbit and sky-view camera, Earth-lock, fly-to tweens; analytic globe and glyph picking. |
| UI | `js/ui/index.js` and its modules | Shell, top bar, time bar, Sky Now, body card, events, layers, settings, about, help, toasts, shortcuts, announcer. |

---

## 3. Boot sequence

`main.js` runs these steps. The network is never on the critical path.

1. **State.** The observer comes from the URL hash, then the saved preference, then the largest city
   in the device's timezone (`cities.byTz`, canonicalised; on a UTC machine this falls through),
   then the Royal Observatory Greenwich. Layers, display and quality are merged from defaults,
   prefs and the hash. `detectTier` picks the tier from the WebGL probe that `index.html` already
   ran.
2. **Clock and first snapshot.** A hash `t` starts the clock paused at that moment. Otherwise it
   starts Live.
3. **UI.** It mounts immediately. The loop starts headless and publishes 4 Hz readouts, so the
   Sky Now table works before WebGL exists.
4. **Render stack.** It is imported in parallel. The render context is created, then each module in
   its own `try/catch`. Textures start as 1×1 placeholders.
5. **Data.** `data/sky.json`, `data/cities.json` and the critical textures (day and night maps)
   load in parallel. If the catalog arrives late, the sky module gets it through `setCatalog`.
6. **Compile.** `rc.compile()` (three's `compileAsync`) runs behind the loader, capped at 10 s.
7. **Render.** `loop.attach(...)` adds the renderer. Store subscriptions start driving modules.
8. **Ready.** The loader fades when the critical textures are in, after 5 s, or when the user
   chooses "Slow connection — continue with low detail". `status.phase` becomes `'ready'`.
9. **Intro.** It plays on the first visit unless the hash has `intro=0`, a `cam` or `view=sky`,
   or the user prefers reduced motion. Otherwise the beams launch with a short stagger.
10. **Idle work.** Deferred textures (cloud and ocean masks, Moon, Milky Way, flare), one almanac
    and events push from the worker, and service-worker registration (https only). The new
    worker is handed the URLs this visit already loaded, so the next visit works offline.

Feature detection happens in `index.html` before any module loads. With no WebGL2 or no import
maps, the body gets `no-webgl`, the canvas is hidden, `fallback.js` shows the banner, and the panels
carry the app.

### Body classes

`main.js` keeps these classes on `<body>` in sync with the store. `css/app.css` and the inline
critical CSS read them.

| Class | Meaning |
|---|---|
| `is-ready` | The loader is gone. |
| `is-cinema` | The interface is hidden (H). |
| `is-sky` | Sky view. |
| `is-coarse` | Touch-first device. |
| `is-reduced-motion` | The user prefers reduced motion. |
| `tier-low`, `tier-medium`, `tier-high` | The active quality tier. |
| `no-webgl` | Text mode. |
| `is-intro`, `is-intro-out` | The intro is playing (UI hidden), then the UI fade-in. |

---

## 4. State and data flow

```
 pointer / keys ─► UI (js/ui) ──► actions ──► store ──(subscriptions in main.js)──► render modules
                        │            │                                   setLayers · setSelection
                        │            └──► rig (fly-to, view mode)        setQuality · setObserver…
                        └──► clock ──► loop: tick → computeSnapshot → module.apply(snap)
                                                   └─ 4 Hz full snapshot ─► bus 'readout' ─► UI panels
```

- **`store`** holds the durable app state: `observer`, `selection`, `view`, `layers`, `display`,
  `quality`, `ui` and `status`. `set` merges per top-level slice and never mutates, so selectors
  compare with `Object.is`. Persisted keys: the observer (user-chosen sources only, written by
  `actions`), layers, display and the quality setting (written by `main.js` subscriptions).
- **`clock`** owns simulated time. The UI calls it directly for play/pause, rate, steps, Now and
  scrubbing. The loop calls `clock.tick(now)` once per animation frame.
- **`actions`** covers everything with side effects beyond plain state: moving the observer
  (normalised, with timezone and name from the nearest city), selection, view changes, share,
  fullscreen, quality, intro replay, event jumps. The UI's narrator announces state changes, so
  actions only report what the UI cannot infer, such as geolocation errors.
- **`bus`** carries transient events. `readout` is the full-detail snapshot at 4 Hz, published
  only when time or the observer changed. The UI requests its own almanac data through
  `services.astro`. `main.js` pushes one almanac and events set at boot as a head start.
- **Snapshots.** `snap` is frame detail. It is recomputed when sim time moves by 0.5 s or more, the
  observer changes or the clock jumps. `snapFull` is full detail at 4 Hz. Both are preallocated
  once and rewritten in place. `__app.snapshot()` returns `snapFull`.

---

## 5. The frame loop (`js/app/loop.js`, SPEC §E.7)

```
frame(now):  dt = min(now − last, 100)
  t = clock.tick(now)                            // the clock caps wall dt itself (hidden tabs)
  if observer changed or clock jumped or |t − snap.tMs| ≥ 500 ms:
      computeSnapshot(t, obs, snap, 'frame');  module.apply(snap) for every module
  if now − lastFull ≥ 250 ms and something changed:
      computeSnapshot(t, obs, snapFull, 'full');  bus.emit('readout', snapFull)
  moving = rig.update(dt, snap)
  continuous = moving || rig.tweening || clock.isAnimating() || introPlaying || pointer held || twinkle in sky view
  if dirty || continuous:
      dirty = false                              // cleared first: invalidate() during update requests the next frame
      module.update(fi) for every module         // fi: dt, time, camera, viewMode, skyBlend, snap, pulses, exposure
      rc.render();  labelsFeed.sync();  labels.update(camera, viewport, {cap})
      governor.sample(dt) if the previous frame also rendered
  requestAnimationFrame(frame)                   // stops while the tab is hidden; resumes dirty
```

- **Render on demand.** Live at 1× redraws about twice a second, when the snapshot goes stale. A
  paused, idle app draws nothing. A module that animates, such as a texture swap, the launch tween
  or a pulse fade, calls `rc.invalidate()`. `rc.onInvalidate` is wired to `loop.invalidate()`.
- **Strikes.** Every module call is guarded. A module that throws three times has its `object3d`
  hidden and stops being called, and one toast names the feature. A renderer that keeps throwing
  hands over to text mode through `onRenderFailure`.
- **No allocation.** One `FrameInfo` and one exposure object are reused. The option objects are
  frozen constants. Loops are indexed.
- **Label cap.** Sky view uses the tier's `labelCap`. Orbit view caps at 18 to keep the globe clear.

---

## 6. Frames and units, the contract (summary; details in ASTRONOMY.md)

- **Scene frame.** +Y is the J2000 north celestial pole. 1 unit is one Earth equatorial radius
  (6378.137 km). The Earth's centre is at the origin.
- **`S`** maps EQJ (J2000 equator) to the scene: `(x, y, z) → (x, z, −y)`. It is a proper rotation.
  Star, constellation and Milky Way positions are static in this frame.
- **Earth.** `earthMatrix = embed(S·E·Sᵀ)` with `E = PN·Rz(GAST)`, recomputed with every snapshot.
  The stock `SphereGeometry` with an equirectangular texture is already the Earth-fixed frame, so
  no texture offset is needed. Precession shows up as the Earth's axis moving inside the static sky.
- **Observer.** The pin sits on the unit sphere at the geodetic lat/lon. `upS`, `northS` and
  `eastS` are the local ENU basis in the scene frame.
- **Directions.** `dirS` (topocentric astrometric J2000) drives beams, glyphs and labels.
  `geoDirS` (geocentric) drives sub-points and the visibility footprint.
- **At infinity.** Sky objects use an at-infinity vertex chunk (depth ≈ 1), so they never depend
  on the far plane. The Earth and the true-scale Moon (about 60 units away) occlude them by depth.

---

## 7. Render modules

Every `js/render/*` feature exports `createX(rc, deps)` returning a `RenderModule`:

```js
{ object3d,                 // required: main adds it to the scene (modules never add themselves)
  apply(snap),              // a new snapshot (≤ 2 Hz idle, every frame while animating)
  update(fi),               // every rendered frame
  setLayers(layers), setViewMode(mode, skyBlend), setSelection(id|null), setQuality(tierCfg),
  dispose() }               // required
```

To add one:

1. Write `js/render/foo.js` and follow R5 and R6.
2. Add `foo: import('./render/foo.js')` to `importRenderStack()` in `main.js`.
3. Add `create('foo', …)` next to the others. The order of that list is the update order.

It then receives layers, selection, tier and view changes, and its failures are contained.

The render order is fixed in SPEC §E.1. From back to front:

- −100: Preetham dome
- −90: Milky Way
- −80: grids and constellation lines
- −70: stars
- −60: Sun, planets, trails
- −50: ground and haze
- 0: Earth and Moon
- 10: clouds
- 20: atmosphere
- 30 and 31: beams, normal and x-ray
- 40: pin
- 50: flare

**Globe ↔ sky transitions.** The rig (`stepToSky` / `stepToOrbit`) drives `skyBlend`. The sky
dome, stars and exposure follow it. The sky-view ground, the clouds and the atmosphere shell follow
`groundCover(skyBlend)` (`render/sky.js`) instead, which completes at skyBlend 0.5 while the camera
still looks down. Only then does the camera pitch up to the horizon (`DESCENT_*` in `rig.js`).
Above the observer the globe's rim sits several degrees below the sky-view horizon, so a globe
still visible there shows a second horizon. `test/render.transition.test.mjs` checks that the rim
stays out of view until the cover is complete.

### Labels

`labels-feed.js` builds `LabelAnchor`s and `render/labels.js` (a pooled DOM layer in
`#labels-root`) projects and declutters them. Anchors hold live vectors, and the list is rebuilt
only when selection, layers, observer name, view mode, catalog, trails or the intro reveal
change.

- **Bodies** use the beams module's `labelAnchor(id)`. In orbit view that is the farthest on-screen,
  unoccluded point of the beam. In sky view it is the direction at infinity. It reads NaN until the
  beam lands, so labels appear as the launch completes.
- **Orbit view** adds the observer label at the pin head and N/E/S/W on the horizon-disc rim.
- **Sky view** adds the cardinal points just above the horizon, bright star names (mag ≤ 2.5) and
  constellation names.
- **Priorities:** selected 100, Sun and Moon 90, planets 80, observer 70, cardinal 60, stars 50 − mag,
  constellations 20.
- **Free area.** `rc.size` is `{w, h, insets}`; `rig.setViewInsets` keeps `insets` in sync with the
  side panel / bottom sheet. Beam anchors stay inside that free area (a beam that leaves the
  screen is labelled where it exits), and are de-overlapped in priority order by sliding along
  their own beam.
- **Labels never sit under UI chrome or off-screen.** `labels.js` treats the rects of
  `.ui .topbar > *, .ui .viewbar > *, .ui .timebar, .ui .panel, .ui .sheet` (`OCCLUDER_SELECTOR`)
  as occluders, re-read on resize and at most every 500 ms while rendering — never per frame. A
  label overflowing the viewport by ≤ 12 px is nudged inside, otherwise hidden. If you rename
  those UI classes, update `OCCLUDER_SELECTOR`.
- **Exports used by `beams.js`:** `labelExtent(id)` (measured label box, cached per id) and
  `uiOccluders()`.

---

## 8. Quality tiers

| | Low | Medium | High |
|---|---|---|---|
| DPR cap | 1.0 | 1.5 | 2.0 |
| Composer / MSAA | none (context antialias) | yes / 4 (0 on touch) | yes / 4 |
| Bloom | none | 0.55 / 0.4 / 0.9 @ ½ res | 0.6 / 0.45 / 0.9 |
| Earth | 64×32, `day2k`, derived ocean mask, no clouds | 96×48, `day4k`, specular mask, 1k clouds | 128×64, `day4k`, roughness, 4k clouds + shadows + bump |
| Atmosphere | analytic | analytic | ray-marched (8 steps) |
| Stars to mag | 5.0 | 6.0 | 6.5 |
| Flare / twinkle | — / — | ✓ / — | ✓ / ✓ |
| Labels | 12 | 24 | 40 |

- **Choosing the tier.** `detectTier` uses the renderer string, touch input, device memory, max
  texture size and Save-Data. Software renderers get Low. Touch devices are capped at Medium.
  Discrete GPUs get High.
- **Switching.** Settings and `?q=` pin a tier. Auto lets the governor step down, never up. If the
  frame-time EMA stays above 1.3 × the budget for 2 s, it lowers the DPR by 0.25 and then drops a
  tier, with a 5 s cooldown. Under `navigator.webdriver` the governor is never sampled.
- **Applying a tier.** `applyTierCfg` calls `rc.setTier` and each module's `setQuality`, then loads
  the tier's textures. The scene graph is never rebuilt.

---

## 9. Failure handling

| Failure | Behaviour |
|---|---|
| No WebGL2, or no import maps | Text mode: banner, no canvas, a fully working panel UI. |
| A module script fails to load or has a syntax error before boot | The inline loader shows "Something went wrong loading Planet Location Marker." with Reload and details. |
| Boot throws after the UI is mounted | Text mode with the "3D view stopped working" banner. |
| A render module throws at creation | That feature is skipped and the rest renders. |
| A render module throws per frame | Three strikes, then it is hidden, with one toast. |
| The renderer throws | Text mode (`context-failed`). |
| `webglcontextlost` | Rendering pauses (the panels keep updating) and a non-blocking "Graphics were reset — restoring…" overlay appears. On restore, `textures.restore()` runs, the composer targets are rebuilt by the context, and rendering resumes. |
| A texture fails | The placeholder stays, with one "Some imagery couldn't load." toast. |
| `sky.json` fails | No stars or constellations, and a toast. |
| The worker fails | The client falls back to the main thread transparently. |
| All geocoders fail | Offline cities still work, and the palette shows the hint. |
| Geolocation is denied | Toast, and the location palette opens. |
| Bad hash values | They are dropped, with the toast "Some link settings were invalid." An out-of-range `t` is clamped, paused, and gets the 1000–3000 toast. |
| Slow network | After 8 s the loader offers "continue with low detail". After 40 s without code, it says so. |

---

## 10. URL hash

```
#loc=21.0285,105.8542&n=Hanoi&cc=VN&tz=Asia/Ho_Chi_Minh&el=15&t=2027-08-02T10:07:00Z&r=3600&p=1
 &view=orbit&lock=1&sel=moon&ly=bgoscCnmkazhl&q=auto&cam=o:21.0,105.8,3.2&intro=0&debug=1
```

- No `t` means Live.
- `r` is the signed rate in sim-seconds per second, snapped to the ladder.
- `ly` is the exact set of enabled layers.
- `cam` is `o:lat,lon,dist` (the sub-camera point) or `s:az,alt,fov`.

`bindUrl` writes the hash at most every 500 ms and leaves a fresh visit's URL clean. Hand edits
are applied live through `onExternalChange`.

---

## 11. Debugging, testing, tooling

- **`window.__app`** has `ready`, `version` and `tier`; `snapshot()` for the full-detail snapshot;
  `stats()` returning `{fps, frames, drawCalls, geometries, textures, beamsVisible, labelsVisible,
  phase, tier, disabled}`; and `store`, `clock` and `actions`. `__app.internals` exposes the render
  objects for console spelunking. It is not a stable API.
- **`?debug=1`** in the hash, or the Backquote key, shows the debug overlay: fps, ms, draw calls,
  memory, tier.
- **`npm test`** runs the `node:test` suites: astronomy against fixtures, core and geo, data, and
  repo rules (import-map closure, purity, no external URLs, assets exist).
- **`npm run smoke`** opens the app in headless Chrome (SwiftShader) with every non-local host
  blocked. It waits for `__app.ready` and asserts no console errors, `phase === 'ready'`,
  `frames > 10`, `beamsVisible ≥ 7`, and stable geometry and texture counts while time runs at
  1 day/s. Useful flags: `--mobile`, `--tz=UTC`, `--reduced-motion`, `--subpath=/repo/`,
  `--url=/#…`, `--out=shot.png`, `--eval="js"` (awaited before the screenshot). For the failure
  matrix and the intro: `--no-webgl` (text mode), `--init="js"` (runs before the page, e.g.
  `HTMLScriptElement.supports=()=>false` for no import maps), `--fail=data/sky.json,earth_day`
  (those requests get HTTP 404 and are not judged) and `--at=1000,3000` (timed screenshots
  `<out>-<ms>.png`; the run then skips its wait for the intro to finish).
- **`npm run size`** enforces the per-tier transfer budgets (low 3.8 MB, medium 4.3 MB, high
  5.4 MB raw, re-baselined from the spec's estimate to the measured unminified module graph; every
  tier stays under 6 MB) and the 12 MB deploy limit.

## 12. Conventions

- Modern ES2022 modules, 4-space indent, semicolons, single quotes, `const` by default.
- JSDoc on every export. Comments explain *why*.
- No TypeScript, no bundler, no npm runtime dependencies.
- No module throws at import time.
- Render-module constructors tolerate placeholder textures and an empty catalog.
- A healthy boot logs one `console.info` line and nothing else. The smoke test fails on console
  errors.
- Product copy in JavaScript uses `APP_NAME` from `js/version.js`.
