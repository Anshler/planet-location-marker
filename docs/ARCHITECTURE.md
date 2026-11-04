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
   ├─ js/geo/     offline cities, online geocoder, lat/lon parsing, landscape profile     PURE
   ├─ js/astro/   astronomy: frames, snapshot, almanac, events, paths, worker + client    PURE
   ├─ js/data/    star-catalog decoder                                                    PURE
   ├─ js/app/     actions (UI → app API), frame loop, label feed, intro, tours, fallback  glue
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
| | `js/main.js` | Boot sequence, service wiring, store-to-module subscriptions, click picking, tier switching, the intro runner, the guided-tour loader (`startTour`), `window.__app`. |
| App glue | `js/app/actions.js` | `createActions(deps)`: the only API the UI calls besides `store` and `clock`. Also `normalizeObserver`, `eventFraming` (how a jump frames its event), `eclipseFocusExpired`, `eclipsePlayRange` and `lookSpanning`. |
| | `js/app/eclipse-chase.js` | `ribbonPlan` (which eclipse the globe's path ribbon shows), `chaseLegs`/`chaseTarget` and `createEclipseChase` (the shadow chase behind `actions.chaseEclipse`). No three.js. |
| | `js/app/loop.js` | `createLoop(deps)`: the frame loop with render-on-demand, guarded module calls and strikes, governor sampling, the 4 Hz readout and idle supersampling (extra jittered frames once nothing moves, `core/sampling.js`). `redraw()` draws one frame on demand (captures); `step(now, dt, io)` runs one whole frame on a caller's time base (video sessions). |
| | `js/app/capture.js` | `createCapture(deps).frame(opts)`: the scene rendered once at a requested size into a 2D canvas, with the label feed's labels reprojected for that camera (`projectAnchor`, `projectLabels`, `paintLabels`). Postcards and the long exposure's Save image. `session(opts)`: the same, frame after frame at one size (the time-lapse video). No three.js. |
| | `js/app/recorder.js` | Time-lapse video export, loaded on demand by `actions.recordVideo`: the pure frame plans (`videoPlan`: holds and clock ranges for a day, a night of star trails, the 2027 eclipse chase; `nightSpan`), `pickEncoder`, and `recordVideo` (deterministic frames on a virtual time base, WebCodecs into `mp4.js`, else MediaRecorder in real time; state restored afterwards). No three.js. |
| | `js/app/mp4.js` | A tiny faststart MP4 muxer for one H.264 (`avcC`) or VP9 (`vpcC`) track, pure; `mp4Boxes` walks boxes (tests). |
| | `js/app/expose.js` | Long-exposure presets, pure: `photoLayers` (no line art in a stack), `trailsLook`, `nextDarkMs`, `meanNoonMs`, `analemmaPlan`. |
| | `js/app/labels-feed.js` | `buildAnchors(state, snap, catalog, trails)` and `createLabelsFeed(deps)`: label anchors with live vectors. |
| | `js/app/intro.js` | `playIntro(opts)`: the first-visit camera flight, pin drop and beam launch (after a pre-roll that holds the opening pose while the loader fades). |
| | `js/app/tours.js` | Guided tours, loaded on demand: the pure step builders (`tonightSteps`, `yearSteps`, `eclipseSteps`, `ambientSteps`) and `createTourRunner` (captions, pause/resume/next, state capture and restore). No three.js. |
| | `js/app/fallback.js` | Text-mode banner, context-lost overlay, fatal-error hand-off. |
| Core | `js/core/store.js` | Immutable slices, selector subscriptions, `DEFAULT_STATE`. |
| | `js/core/bus.js` | Fixed event types: `readout`, `toast`, `announce`, `almanac`, `events`, `intro`. |
| | `js/core/clock.js` | Simulated time: Live mode, the signed rate ladder, steps, log-time tweens, range loops, clamping to 1000–3000. |
| | `js/core/url-state.js` | `parseHash`, `serializeHash` and `bindUrl`, which keeps the URL hash in sync (throttled `replaceState`; held while `suspended()`, i.e. during a tour). |
| | `js/core/tour-catalog.js` | `TOURS` (id, title, blurb, running time), `TOUR_IDS`, `isTourId`: what the Events tab lists and `#tour=` accepts. |
| | `js/core/quality.js` | `TIERS`, `detectTier`, `tierConfig`, `autoStartTier`, and `createGovernor` (downgrade only, display-cadence budget). |
| | `js/core/sampling.js` | Renderer policies, pure: `halton`, `createSupersampler` (idle supersampling: which frames accumulate, their weight and jitter, when to park), `viewMotionPx`, `streakShutter` and `strobeDim` (fast-time streaks). |
| | `js/core/prefs.js` | `localStorage` under `pc2.`, falling back to memory. |
| | `js/core/tz.js`, `js/core/format.js` | Time zones (canonicalised, DST-safe) and every displayed number and string. |
| | `js/core/types.js` | JSDoc typedefs: the shared contract. |
| Geo | `js/geo/cities.js` | About 1,600 GeoNames cities. Fuzzy search, `nearest`, `byTz`. |
| | `js/geo/geocode.js` | Online providers with timeouts, a circuit breaker and an LRU cache. |
| | `js/geo/coords.js` | Parses decimal and DMS coordinates. |
| | `js/geo/mapview.js` | The flat world map: the plane's frame (`orientMapFrame`: north up, square to the camera that entered it, `MAP_LIFT` clear of the globe), `mapPoint`/`mapPointOfDir` (the projection the Earth's vertex shader shares) and the analytic inverse `mapRayHit` (picking), `mapFitDistance`. |
| | `js/geo/horizon.js` | The sky view's illustrative landscape: a per-place horizon profile (far ridge, trees or roofs, sea sectors), its queries (`horizonAltDeg`, `clearanceDeg`) and the urban index. Invented, seeded by place (ASTRONOMY.md §6). |
| Astro | `js/astro/ae.js` | Re-exports astronomy-engine. |
| | `js/astro/bodies.js` | `BODIES`. Its order is a contract. |
| | `js/astro/frames.js` | The S mapping, Earth orientation, ENU, alt/az, matrix helpers. |
| | `js/astro/snapshot.js` | `computeSnapshot`: everything about one instant, into preallocated arrays. |
| | `js/astro/almanac.js`, `events.js`, `paths.js` | Rise/set, twilight, Tonight; events (with eclipse contacts, `localSolarEclipseAt`); retrograde paths. |
| | `js/astro/eclipse-path.js` | `eclipsePath`: the centre line and limits of a central solar eclipse; `citiesInPath`, `nearestCentrePoint`, `pathAt`, `shadowPoint`. Render support: `ribbonMesh` (the globe's ribbon, once per eclipse), `pathFrameLocal` (the shadow and its heading, allocation-free), `shadowAxisPoint`, `umbraNear`. |
| | `js/astro/worker.js`, `client.js` | Module worker plus a Promise client with a main-thread fallback. |
| | `js/astro/parallax.js` | `compareSight(snapA, snapB, i)`: a body seen from two places at one instant: the angle between the two sightlines, the baseline and the distance they imply (the Moon's parallax). |
| | `js/astro/shadow.js`, `photometry.js` | Eclipse disc overlap; B−V colour, refraction (and `liftByRefraction`, the sky view's drawn positions), airmass, limiting magnitude, adapting luminance (night vision), exposure. |
| | `js/astro/skyglow.js` | The night sky's own brightness: KS91 moonlight, van Rhijn airglow, Walker's-law light pollution from `data/cities.json` (16-bin azimuth dome), SQM, Bortle, limiting magnitude; `computeSkyglow` fills `snap.skyglow`. |
| | `js/astro/disc.js`, `moons.js` | A body's disc as seen from the observer: the sky-plane frame and pole/prime meridian/Sun in it (`discFrame`, `discView`), shapes, Saturn's ring radii, the moons' log spacing; Jupiter's Galilean moons at Jupiter's light time with transit/occultation/eclipse/shadow flags (`computeGalilean`), the libration's limb feature, Saturn's next edge-on run. Shared by the medallions and the eyepiece card (ASTRONOMY.md §4). |
| | `js/astro/geomag.js` | The IGRF centred dipole (1900–2030, held outside) and the Starkov auroral ovals for an activity setting (quiet / typical / storm = Kp 1 / 3 / 7, never live data); `computeAurora` fills `snap.aurora` (pole, magnetic noon, the 48-float boundary table, the animation phase); `auroraText` for the Sky panel. |
| | `js/astro/totality.js` | Totality from the ground: Baily's beads (lunar limb profile), corona epoch parameters, contact-time display adaptation, the horizon ring's azimuthal shape. Illustrative in detail (ASTRONOMY.md). |
| | `js/astro/orrery.js` | The solar-system zoom, pure: the crossfade (`systemBlend`, 80 → 150 R), the camera's pose (`systemPose`: pivot sliding from the Earth to the Sun, ecliptic direction, `liftLat`), the orbit polylines (`orbitPolylines`, the worker's `orbits`), the retrograde figure's sight lines (`sightAt`, `sightLines`, `sightStepMs`) and the edge arrows' place (`edgeExit`). |
| | `js/astro/vantage.js` | Vantage points (loaded by the rig on first use): the L1 pose (235 R sunward, 4° toward ecliptic north, north up, 0.7°), the Earthrise orbit (`planLunarOrbit`: 150 km up, in the plane through the Earth direction nearest the ecliptic, rising over the sunlit limb; `lunarOrbitPose`: the orbiter's place at any time, looking along its track), `vantageFov`, `vantageNear`, `moonInFront`. |
| | `js/astro/sky-guide.js` | Finding it in the real sky: hands at arm's length (`handSpan`: a fist ≈ 10°, a finger ≈ 1°), `findIt` ('Face south-east, 4 fists up from the horizon, 1 fist left of the Moon.'), `guideRefs` (the Moon, bright planets and, by night, 24 bright J2000 stars as signposts), the ruler's numbers (`separationDeg`, `fmtAngle`, `rulerText`) and `edgeHit` (where an off-screen pointer meets the free area's edge). |
| Data | `js/data/catalog.js` | Decodes `data/sky.json` into GPU-ready typed arrays in the scene frame. |
| Render | `js/render/context.js` | Renderer, scene, camera, tier switching, `invalidate`/`onInvalidate`, context loss, stats; `setAccumulation` (long exposures), `capture` (a one-task render at another size), video sessions (`beginCapture`, `captureCamera`/`releaseCamera`, `endCapture`), `render(ss)` (a jittered supersampling sample; a shown overlay takes the same jitter) and `setOverlay` (a second scene drawn over the first with its own camera and depth: the orrery). |
| | `js/render/postfx.js` | Composer with bloom and the final pass (FXAA when the scene target has no MSAA; the night-vision grade, `rc.setVision`). An `OverlayPass` right after the scene draws the overlay scene (`setOverlay`). While Expose is on, `AccumPass` (`accum.js`: two half-float targets, max-stacking, bright-only for the analemma) sits between the scene and the bloom; otherwise, on tiers that supersample, `SupersamplePass` (`supersample.js`: one half-float history, a hardware-blended running mean) sits there. |
| | `js/render/streaks.js` | Fast-time star streaks, a render module for its per-frame hook: measures the camera's turn since the last frame and publishes `STREAK_UNIFORMS` (the shutter's opening as a world → view mat3, the cap), shared by the stars and the planet glyphs (`STREAK_VERT_CHUNK`), and `streakState.dim` for line art and the Milky Way. |
| | `js/render/orrery.js` | The solar-system zoom's orrery: its own scene and camera in AU (the overlay), orbits, the Earth→body sight lines the beams fade into, sprites lit by the Sun, the Sun on the bodies' `DISC_FRAG`, the retrograde figure for a selected planet, edge arrows; live label points (`labelPoint`, `labelOffset`) and `pick`. Shaders in `shaders/orrery.glsl.js`. |
| | `js/render/long-exposure.js` | The long exposure's controller, a render module for its per-frame hook: turns stacking on in sky view while `ui.expose` is set, resets the stack when the framing changes, gates star trails by daylight, reports `stats()`. |
| | `js/render/textures.js` | Placeholder-first texture store with byte-weighted progress. |
| | `js/render/earth.js`, `atmosphere.js` | Earth shader (day, night lights with close-zoom filtering, sun glint and moonglint, moonlight, twilight, sculpted clouds, the face-on aurora, eclipse shadow, footprint) and atmosphere. |
| | `js/render/aurora.js` | The aurora's limb-curtain shell (High and Max) and the driver of `AURORA_CHUNK` (`shaders/aurora.glsl.js`), whose uniforms the Earth and cloud materials also carry for the face-on oval on every tier. |
| | `js/render/skyglow.js` | Uniforms of `SKYGLOW_CHUNK` (`shaders/skyglow.glsl.js`), filled from `snap.skyglow`: the moonlit sky and the city light dome per direction, for the dome, ground, stars and Milky Way. |
| | `js/render/sky.js`, `bodies.js`, `ground.js` | Stars, constellations, Milky Way and grids; Sun (with totality's thin crescent, corona, chromosphere and prominences under `SUN_ECLIPSE`), planets and the true-scale Moon; sky-view dome and ground (totality's 360° horizon ring, the illustrative landscape and sea, twilight- and moonlit land). |
| | `js/render/planets.js` | Planet medallions: each orbit-view beam ends in a magnified (~26 px) mini-globe at its label anchor, drawn by the shared impostor `PLANET_CHUNK` (`shaders/planets.glsl.js`: oblate spheroid on the IAU pole, true phase, Saturn's rings and their shadows, Jupiter's moons and shadows; reusable at true scale via `writeDiscInstance`/`writeJupiterMoons`). |
| | `js/render/totality.js` | Baily's beads and the diamond ring: up to eight HDR point sprites at `snap.eclipse.beads` (the flare's starburst follows the brightest). |
| | `js/render/beams.js`, `pin.js`, `labels.js` | Signature beams, observer pin and horizon disc, DOM label pool. A second instance of each (`{second: true}`: `beams2`, `pin2`) draws the second place from `snap.second`: amber pin, dashed amber-tinted beams. The pin rides the map morph onto the map. |
| | `js/render/ruler.js`, `edge-chips.js` | The angle ruler (a great-circle arc between two tapped ends, fixed buffers, its reading as a `'ruler'` label); the off-screen pointers (a DOM chip at the free area's edge per findable body outside the field, a tap turns there). |
| | `js/render/trails.js`, `flare.js`, `debug.js` | Retrograde paths, procedural lens flare (six-spike starburst, hexagonal aperture ghosts; no textures), `?debug=1` overlay. |
| | `js/render/eclipse-path.js` | The path of a central solar eclipse on the globe: ribbon, centre line, 30-min ticks, the live umbra marker; reveal modes for the chase. |
| Camera | `js/camera/rig.js`, `picking.js` | Orbit and sky-view camera, Earth-lock, fly-to tweens, `follow()` (the shadow chase), sidereal tracking, `setVantage()` (View from L1, Earthrise), the flat map (`setMode('map')`, `mapK`, `mapFrame`), the system zoom past 150 R (`setSystem`, `system`, `systemBlend`, `onSystemChange`), `frameSpan()` (the Earth–Moon framing), `setAiming()`/`setSkyAim()` (the phone steers the look); analytic globe, map (`pickMap`), glyph and map-point (`pickPoint`) picking. |
| | `js/camera/aim.js` | 'Point at the sky' (loaded on first use, no three.js): device orientation → the rear camera's direction and the screen's up in ENU (`deviceVectors`), a level look (`lookOf`), an adaptive vector low-pass (`aimFilterStep`), and `createAim` (sensor events, iOS compass learning, deadband, Align offset, idle and hidden stops, wake lock). |
| UI | `js/ui/index.js` and its modules | Shell, top bar, time bar, Sky Now, body card (with `eyepiece.js`: the 2D-canvas eyepiece portrait, also in text mode), events (with the guided tours), Eclipse Companion, the tour's lower third (`tour-bar.js`), layers, settings, about, help, toasts, shortcuts, announcer; the share menu, `postcard.js` (postcard and Save-image dialog, the typographic band), `video.js` (the time-lapse video dialog: presets, frame size, progress and preview, the burned-in date stamp) and `expose.js` (Expose presets and the exposure's status pill); the vantage menu and its caption pill (`view-switch.js`: vantage points, the world map, the solar system).; the ruler and 'Point at the sky' buttons with their status pills (`sky-tools.js`); the body card's 'Find it' line.; the world map entry and the second place (`Compare with…` in the place search) |

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
9. **Intro.** It plays on the first visit unless the hash has `intro=0`, a `cam`, `view=sky` or
   `tour`, or the user prefers reduced motion. Otherwise the beams launch with a short stagger. It
   holds its opening pose for the loader's 0.7 s fade (pre-roll), and the horizon disc grows out
   with the pin's ripple. A `tour=` link starts its tour here (also in text mode).
10. **Idle work.** Deferred textures (cloud and ocean masks, Moon, Milky Way), one almanac
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
| `tier-low`, `tier-medium`, `tier-high`, `tier-max` | The active quality tier. |
| `no-webgl` | Text mode. |
| `is-intro`, `is-intro-out` | The intro is playing (UI hidden), then the UI fade-in. |
| `is-touring` | A guided tour plays (`ui.tour`): toasts move above its lower third. |
| `is-system` | The globe view is zoomed out into the solar system (`view.system`, the orrery past half its crossfade). |

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
- **Event jumps** (`jumpToEvent`, framed by the pure `eventFraming`). A local total or annular
  solar eclipse lands 20 s before second contact with the clock playing at 1×, in sky view on the
  Sun at a 5° field; a partial one paused on its `visibleMs` at 10°; a lunar eclipse seen from
  here on the Moon at 5°. The field rides on the rig's look (`setMode('sky', {look: {azDeg,
  altDeg, fovDeg}})`): one look tween in sky view; from the globe a zoom chained after the descent,
  which lands at 70° as before.
- **Sidereal tracking and the telescope** (`view.track`, url `trk=b|s`, K). In sky view the rig
  can keep the selected body centred at its refracted place (`'body'`, zenith up) or hold the
  star field still with the J2000 pole up while the horizon swings (`'stars'`); engaging and
  releasing blend the orientation over 600 ms, a drag moves the tracked aim, and below −8° the
  rig ends it and `main.js` toasts. `actions.telescope(id)` frames a body at `telescopeFov` (Jupiter
  with its moons, the Moon whole, else the 0.2° `SKY_FOV_MIN`) with tracking on; the zoom eases in
  log space. Below `FINE_FOV_DEG` (2°) the loop recomputes the frame snapshot on every frame that
  sim time moved and keeps drawing while the clock runs. Planets cross-fade from glyphs to the
  shared impostor at true size (`astro/disc.js scopeBlend`, `render/planets.js` telescope mesh),
  Jupiter's moons become discs below 6°, and the star limit gains up to 3.5 mag (`scopeGainMag`).
- **The eclipse in focus**, `ui.eclipse = {peakMs, kind, local, eventId}`: set by a jump to a solar
  eclipse, cleared by any other jump and once simulated time is more than a day from `peakMs`
  (`main.js`, on `readout`, never during the jump's sweep). Render and HUD modules key their
  eclipse extras on it. `actions.eclipsePath(peakMs)` is the shared, cached worker request for
  that eclipse's path and the largest cities in its band, and `actions.standInPath(peakMs | event)`
  moves the observer onto the centre line (nearest point, or `{at: 'greatest'}`) like any observer
  change (named, saved, Undo) and then jumps to the eclipse as seen from there.
  `actions.playEclipse(event)` runs the pure `eclipsePlayRange(event)` as a once-through 40 s
  timelapse (C2 − 2 min … C3 + 2 min for a central phase above the horizon, else C1 … C4; U1 … U4
  for the Moon) and turns the sky view to a `lookSpanning` field that holds the body's drift.
- **The path on the globe** (`render/eclipse-path.js`). `main.js` keeps it in step with
  `ribbonPlan` on every readout and `ui.eclipse` change: the eclipse in focus, else one in progress
  (`snap.eclipse.solar`); a loaded path, a request in flight or a known miss (a partial eclipse)
  within half a day holds. It requests `actions.eclipsePath`, so the ribbon and the panels share one
  worker call. `render.eclipsePath` gives actions the module (its reveal mode).
- **The shadow chase**, `actions.chaseEclipse(peakMs | event)` (`app/eclipse-chase.js`). It focuses
  the eclipse on the globe, parks the clock at the path's sunrise end and hides the ribbon ahead of
  the shadow, then `rig.follow()` glides into low orbit behind the umbra (0.35 R up, 14° back,
  0.5 R and 18° on low). On arrival the clock runs two eased `once` ranges, start → greatest eclipse
  (`ease: 'out'`) and, after a 1.5 s hold, greatest → end (`'in'`), 40 s in all. At the end the
  whole ribbon shows and the camera pulls back over greatest eclipse. Input on the canvas cancels
  only the follow (the controls take over with a 450 ms orientation blend); a clock change of the
  user's ends the chase where it is. Reduced motion: a static frame over greatest eclipse, paused
  at its instant, the whole path drawn. `actions.stopChase()` ends it; `actions.chasing` reports it.
- **Eclipse Companion** (`js/ui/eclipse-hud.js`, a shell region: under the top bar, left of the
  floating column on phones, inline above the panels in text mode). It shows the eclipse in focus
  (contacts recomputed with `localSolarEclipseAt` on observer changes) or a local solar or visible
  lunar eclipse whose [first contact − 3 h, last + 30 min] holds the simulated time. Countdown,
  contact track and disc are written from the 4 Hz `readout` only when they change; it announces
  itself once per eclipse. 'Stand in the path' appears outside the
  band of a central eclipse (the global `solar-eclipse` event, or a global focus, says which).
- **Long exposure** (`ui.expose = 'trails' | 'analemma' | 'free' | null`, not in the URL; sky view
  only, the globe ends it). `actions.expose(kind)` applies an `app/expose.js` preset: star trails
  jump to tonight's darkness (Sun below −12°), run at 10 min/s with tracking off and face the
  visible pole; the analemma is a one-year `once` range at mean solar noon with a one-day
  `strideMs` (the clock steps whole days, at most one per tick, so a slow frame rate stretches the
  timelapse instead of skipping days), held on its first day until the look tween has landed.
  `render/long-exposure.js` (a module, for its per-frame hook) calls `rc.setAccumulation(true)`:
  postfx adds `AccumPass` (two RGBA16F targets at the drawing-buffer size, allocated then and freed
  on stop; a lost context drops them with the composer; a low tier booted on the direct path gets
  the lean chain without bloom meanwhile). Each rendered frame is max-stacked; the stack resets
  when the rig's local view (`getView`, or the tracking mode while tracking), a rig or clock tween,
  a drag, a clock jump, the layers, the observer, the size, the pixel ratio or the tier changes,
  never on the camera's world matrix (it turns with the Earth every frame). Star trails keep, but
  stop adding to, the stack while the Sun is above −8°; the analemma stacks bright-only (the first
  frame, then only the Sun's HDR core). While exposing `main.js` gives the renderers
  `photoLayers` (no constellation figures, grids, ecliptic or paths) and no selection (no reticle),
  hides the flare and stops twinkle; CSS hides the DOM labels (`body.is-exposing`). The store's
  layers and selection are untouched. `actions.exposeStatus()` feeds the status pill.
- **Capture** (postcards, Save image). `actions.capture({width, height, scale, labels,
  insetBottom})` → `app/capture.js` → `rc.capture`: in one task the renderer, the composer (the
  stack frozen and bypassed) and the camera (aspect; the shorter side keeps the screen's shorter
  side's angle, capped at 110°; the view centred above a caption band) are set to the card's own
  size, `loop.redraw()` runs the module updates, the label-feed sync and `rc.render()`, the canvas is
  drawn into a 2D canvas, and everything is restored and redrawn before the task yields, so nothing
  is presented and nothing flashes. Labels are the feed's anchors reprojected with that camera, not
  DOM rects. With no size it is the screen frame itself (a long exposure's stack included). The UI's
  `postcard.js` lays out the band first (date and time, place, 'Up now', the selected body's
  sentence, the brand mark), encodes a JPEG as soon as its dialog opens, and shares it with
  `navigator.share({files})` straight from the next tap (iOS needs that fresh activation) or
  downloads it. Text mode draws the band on a drawn night sky.
- **Time-lapse video** (Share → Video, `ui/video.js`; 3D view only). `actions.recordVideo({preset,
  size, signal, onProgress, paint})` imports `app/recorder.js` on first use. `videoPlan` turns the
  preset into holds and clock ranges: 'day' (24 h from now, linear, 12 s), 'night' (dusk to dawn at
  the Sun's −12°, 15 s, sky view facing the visible pole with Expose 'trails' stacking, so the
  trails grow through the clip) and 'eclipse' (2 Aug 2027: the shadow chase's glide, its eased
  legs and the hold at greatest eclipse, about 24 s). The recorder stops the rAF loop and drives
  every frame itself on a virtual time base (1000/fps ms a frame): `clock.setRange` plus
  `clock.tick` advance simulated time by exactly one frame's share, and `render.video.setNow` makes
  the rig's tweens and `follow()` read the same clock (main.js passes the rig `now: () =>
  R.virtualNow ?? performance.now()`). So the frames are deterministic, whatever the GPU's speed. A
  capture session (`capture.session` → `rc.beginCapture`) keeps the drawing buffer, the composer
  and `rc.size` at 1920×1080 or 1080×1920 (720p on low) for the whole clip, screen resizes wait,
  and a long exposure keeps stacking at that size (`opts.stack`). Each frame is one `loop.step()`
  with `rc.captureCamera()`/`releaseCamera()` around its draw (the screen's shorter-side angle on
  the frame's shorter side); its labels are reprojected and painted, then the UI's `paint` burns in
  the date stamp, the place and the brand. Encoding: WebCodecs `VideoEncoder` (H.264 High, Main or
  Baseline, else VP9; 4 bits per pixel per second; a key frame every 2 s; the queue held under 6)
  into the faststart MP4 of `app/mp4.js`, faster or slower than real time; without WebCodecs,
  `MediaRecorder` on the 2D canvas's `captureStream(0)` with `requestFrame()` per frame, paced in
  real time (MP4 where the browser records it, else WebM). One frame per task (yielding through a
  `MessageChannel`), so the page stays responsive and Cancel (`AbortSignal`) acts between frames;
  a clock change by anyone else stops it ('changed'). Afterwards the session ends, the clock (Live,
  a range, a rate), the view and camera, Expose and the eclipse focus are restored and the loop
  starts again. While recording, `html.is-recording` hides the scene canvas (it shows the video's
  frames at another size); the dialog shows a live preview.
- **Idle supersampling** (tiers with `supersample`: medium 8, high and max 16; not low). When the
  loop finds nothing dirty and nothing moving, it keeps drawing extra frames, each offset by a
  Halton(2,3) sub-pixel jitter, until the tier's cap, then idles again. `rc.render(ss)` adds the
  jitter to `projectionMatrix.elements[8]/[9]` (on top of the rig's view-inset offset) for the draw
  only, and `postfx`'s `SupersamplePass` blends the frame into its history with weight `w`
  (hardware blend, one half-float target allocated on first use after a resize); bloom and the final
  pass see the mean, and FXAA steps aside once 4 samples are in. Extra frames skip the module
  updates, the labels and the governor. Policy (`core/sampling.js createSupersampler`): motion (the
  rig, tweens, fast time, the intro, a held pointer) bypasses the pass and the first still frame
  starts a history (`w = 1`, no jitter); any other change starts afresh; a frame that only moved
  sim time (Live 1×'s 0.5 s snapshot steps) is measured (`viewMotionPx`): under ¼ px it joins the
  history as an EMA sample (`w = 1/cap`, no extra frames, so the image never flips between aliased
  and clean), up to 1.5 px it keeps a short history and refines again, beyond that it starts afresh;
  twinkle frames blend with `w ≥ ½`. A long exposure and supersampling never run together (the
  pass leaves the chain while `AccumPass` is in it); captures and video frames are not
  supersampled.
- **Fast-time streaks** (`render/streaks.js`, tiers with `streakPx`: medium 14, high 24, max 32
  device px; not low). At 10 min/s and faster (and only then, so a drag at Live stays crisp) the
  module measures the camera's turn since the previous rendered frame (its world quaternion) and
  publishes the shutter's opening, slerp(now, previous, ½) (a whole frame while a long exposure
  stacks, so trails join up), as `uStreakView`. The star vertex shader projects each star at both
  ends (`STREAK_VERT_CHUNK`), grows the point sprite by the streak and centres it on the midpoint;
  the fragment measures the PSF from the segment, and the light spreads along it (softened, `^0.6`).
  Past the cap (or the GPU's point-size limit) a streak stops growing and dims instead, so 1 day/s
  and faster fade the strobing sky; planet glyph quads stretch the same way. Constellation figures
  and the Milky Way dim with `strobeDim` of the per-frame jump. Off under reduced motion, after a
  frame gap over 100 ms (render on demand: the previous pose is stale), across cuts (> 34° a frame)
  and in captures (dt 0).
- **Guided tours** (`actions.startTour(id)`, the Events tab, or `#tour=<id>` once the app is
  ready). `main.js` imports `app/tours.js` on the first tour and keeps one runner. A tour is a list
  of plain-data steps built from the observer, the time and, for 'Tonight from here', the worker's
  `tonight()` report; each step sets a caption, then any of the observer (source `'tour'`, never
  persisted), the clock (a sweep, a `once` range, a rate, Live, or a per-frame day-by-day stepper),
  selection, layers, Earth-lock, tracking, a sky look or globe flight (the rig's promises, waited
  for at most 5 s), the telescope framing, an event jump or the shadow chase, then holds. While
  `ui.tour` is set, `bindPreferences` saves no layers, `bindUrl` writes nothing (its first write
  afterwards replaces a `tour=` link), the UI narrator is quiet (the runner announces each caption)
  and the mobile sheet is lowered. Esc or 'End tour' ends a tour; other pointer, wheel or key input
  pauses it (Resume replays the step, Next skips it); Ambient ends on input. The end restores the
  observer (keys the tour added are cleared), selection, view, layers, cinema, sheet, the eclipse
  in focus, the clock and, unless input ended it, the camera. Text mode plays captions and time
  jumps; reduced motion lands sweeps on their last day. A link opened during a tour ends it first.
- **Vantage points** (`view.vantage`: `'none' | 'l1' | 'moon'`, url `vt=l1|moon`; the menu by the
  Globe/Sky switch, 'Earthrise' on the Moon's card). `actions.setVantage(kind)` sets the globe view
  with it; 'Globe', 'Sky' and Esc clear it. `main.js` hands it to `rig.setVantage`, which loads
  `astro/vantage.js` and flies there in 4 s (a cut with reduced motion or from a link), the pose
  then recomputed from every frame snapshot: L1 looks back from 235 R sunward at 0.7°; the
  Earthrise orbiter keeps orbiting with sim time from the orbit planned at entry (the Earth 2.2°
  over the limb, rising ~2.9° a minute), so time-lapse makes the Earth rise and set. Controls,
  picking and input are off; `getView()` (the url `cam`) reports the orbit pose it returns to. The
  furniture group (beams, pin, medallions, trails, the eclipse ribbon, the flare), the labels
  (`body.is-vantage`) and the chart layers (constellation figures, grids, ecliptic, footprint,
  sub-points: `drawnLayers`) go when the flight starts and come back when the flight home has
  landed; the store keeps the user's layers. Any other camera move (a fly-to, sky view, the intro,
  the chase, a sky-view event) ends the vantage, and `rig.onVantageEnd` clears the store. A
  globe-view event jump keeps it: from L1 the eclipse shadow crosses the disc.
- **Finding it in the real sky** (sky view; none of it is in the URL).
  - *Off-screen pointers* (`render/edge-chips.js`, a module for its per-frame hook): each body above
    the horizon that the eye can find now (`chipMagLimit` against the Sun's altitude; the selection
    always) and that lies outside the free area gets a chip at its edge: an arrow and the angle from
    the view centre. Near the field the arrow follows the projection; far away (40°→70° blend) it
    follows the turn that reaches the body (azimuth, then altitude, rotated by the zenith's
    direction on screen), so a body behind you points left or right, not over the zenith. Chips
    are spread along their edge, step inside UI chrome that covers it (`uiOccluders`), live in
    `#labels-root` (hidden with the labels) and select-and-turn on a tap.
  - *The angle ruler* (`ui.ruler`, `actions.setRuler`, A). While it is on, `main.js` routes canvas
    taps to `rulerTap`: the body under the tap (18 px), else a named star to mag 3.5, else that
    point (unprojected, refraction taken off). `render/ruler.js` keeps the two ends (bodies follow
    their snapshot direction), draws the arc and 9-px end rings at true directions (the line
    shader lifts them), measures between the lifted places and reports through `onChange`, which
    `main.js` writes to `ui.ruler` (the pill in `ui/sky-tools.js`) and turns into a label rebuild
    (the feed appends `ruler.anchors()`). Leaving sky view or Esc ends it.
  - *'Find it'* in the body card: `findIt(guideRefs(snap))` from the readout, also in text mode.
    Never for the Sun.
  - *Point at the sky* (`ui.aim`, phones with orientation events on a secure page). The button calls
    `actions.pointAtSky`, which asks iOS for motion access synchronously inside the tap, then
    `main.js startAim` imports `camera/aim.js`, ends tracking and a long exposure, and starts it.
    Each sensor event becomes a low-passed forward/up pair in ENU, then a level look sent to
    `rig.setSkyAim` only when it moved by more than ~1/1600 of the field. While `rig.aiming`, drags,
    inertia and arrow keys leave the look alone and pinch/wheel/double-click change only the field.
    'Align' (`alignAim`) takes the selection or the nearest bright body or star (within 35°) as
    where the phone points and saves the azimuth offset (`prefs.aimOffset`). It stops on Stop or
    Esc, after 2 min without movement, when the page is hidden, when sky view is left, or when no
    reading arrives in 3 s; a screen wake lock is held meanwhile.
- **The flat map** (`view.mode = 'map'`, url `view=map` with `cam=m:lat,lon,dist`; M, the vantage
  menu's 'World map'; Esc or 'Globe' returns). The rig orients a plane (`geo/mapview.js`: north up,
  square to the camera's direction, fixed in the world) and glides the camera to face it in 1.1 s
  while `rig.mapK` runs 0 → 1; from sky view it passes through the globe both ways. The loop hands
  `fi.mapK` and `fi.map` (the frame) to the modules: the Earth's vertex shader (`SURFACE_VERTEX`)
  mixes each vertex toward `uMapO + uMapR·λ + uMapU·φ` from the sphere's own uv, without the
  Earth's model matrix (so the map holds still while GAST runs), and keeps `vPosW`/`vNw` of the
  sphere, so day and night, clouds, the eclipse shadow, sub-points and the footprint are lit as on
  the globe; the aerial perspective, the atmosphere shell and the aurora curtains fade out, the view
  vector turns face-on, the pole rows are clipped, and the twilight contours are drawn from
  dot(n, sun). The loop hides two groups past `MAP_HIDE_K` (`attach({mapHidden})`): `space` (bodies,
  totality) and `furniture.space` (beams, medallions, paths, the eclipse ribbon, the flare); the pins
  ride the morph onto the map. `drawnLayers` forces the sub-points on and the star chart off. The
  label feed's `'map'` mode puts each body on its sub-point and the observers on their pins (lerped
  with the morph). On the map a drag pans, the wheel and pinch zoom about the cursor, a click on a
  sub-point dot selects that body, elsewhere it moves the observer (`pickMap`), a double click zooms.
  Until panned or zoomed the map keeps fitting the free area; leaving it returns to the globe pose
  it was entered from, or over the map's centre once it was moved. Camera commands on the map pan
  it (`flyToLatLon`, `frameDir`); a vantage, the chase or the intro first roll it back up.
- **Two places** (`observer2`, url `loc2`/`n2`/`tz2`; 'Compare with…' in the place search and on the
  body card, `actions.setObserver2`, `compareWith`, `frameObservers`). Never saved. The loop computes
  a second frame and full snapshot for it beside the first ones and hangs them on them as
  `snap.second` (null without a second place), so the renderers' `apply(snap)` and the 4 Hz
  `readout` carry both. `beams2`/`pin2` draw it; the label feed adds its pin label and, in orbit view
  with the beams on, a note under the Earth–Moon line with the Moon's parallax and the distance the
  sightlines imply (`astro/parallax.js`, re-read every 0.5 s). Sky now shows the selected body (else
  the Moon) from both places side by side, also in text mode. 'Show both beams' frames the globe
  square to the Earth–Moon line (`rig.frameSpan`, ~100 ER out), where the two Moon beams can be seen
  converging while the others stay parallel.
- **The solar-system zoom** ('powers of ten', `view.system`, set by `main.js` from
  `rig.onSystemChange`; the URL's `cam` carries it as an orbit distance past 150 R, up to 80 AU).
  The wheel, a pinch or '−' at the globe's farthest orbit (150 R), 'Solar system' in the vantage
  menu (`actions.setSystem(true)`: a 4.2 s log flight out to 6 AU from wherever the globe is), or
  a link hands the camera from the orbit controls to the rig's system mode: the view direction held
  in J2000 ecliptic longitude/latitude (fixed in space, so Earth-lock does not apply), a pivot that
  slides from the Earth to the Sun on the way out, the view lifted above the ecliptic and ecliptic
  north turned up (`astro/orrery.js systemPose`). Drag turns it, the wheel and pinch zoom in log
  steps, and zooming back under 150 R returns to the orbit controls. `rig.systemBlend` (80 → 150 R
  from the Earth; 0 in sky view and vantages) is `FrameInfo.systemBlend`: the beams and medallions
  fade by it, the bodies' Sun and planet glyphs at infinity and the flare go past one half, and
  `render/orrery.js` fades in. The orrery is a scene of its own in AU, drawn over the main one
  (`rc.setOverlay`, the composer's `OverlayPass`) with the globe camera mapped across (`earthS + p /
  AU_ER`), so the Earth's dot sits on the shrinking globe and every line keeps its true direction
  (the snapshot's `helio`). The globe camera's near/far follow the Earth's distance out there.
  Past one half the label feed builds 'system' anchors (the orrery's live points, an 'Earth' label
  that flies home, no cardinals), clicks pick the orrery's sprites and arrows, and the UI shows the
  'Solar system · distances to scale · planets enlarged' caption with a Globe button (Esc too). Any
  other camera move (a fly-to, sky view, the flat map, a vantage, the chase, `frameSpan`) first
  zooms back to 150 R (1.8 s), then runs, so the map's morph and the system zoom never overlap
  (`systemBlend` is 0 while `mapK` > 0, and `labelMode` checks the map first); 'Solar system' from
  the map rolls the globe back up before it flies out. The overlay coexists with the frame's other
  passes: it is drawn before the stacking or supersampling pass, an idle supersampling sample
  jitters the orrery camera with the globe camera's (`rc.render(ss)`), and `loop.step()` (the video
  recorder) sets `FrameInfo.systemBlend`, so a time-lapse shows the orrery too. The second place's
  beams fade with the first set's. Orbits come once from the worker (`orbits`); a selected planet
  gets the retrograde figure (ASTRONOMY.md §4). Low tier: lines and sprites only (no disc-shader
  Sun). Text mode: n/a (the vantage menu is hidden).
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
  if observer or sky site changed or clock jumped or |t − snap.tMs| ≥ 500 ms:
      computeSnapshot(t, obs, snap, 'frame');  computeSkyglow(snap, site, snap.skyglow)
      computeAurora(snap, activity, snap.aurora)
      module.apply(snap) for every module
  if now − lastFull ≥ 250 ms and something changed:
      computeSnapshot(t, obs, snapFull, 'full');  computeSkyglow(…);  bus.emit('readout', snapFull)
  moving = rig.update(dt, snap)
  motion = moving || rig.tweening || clock.isAnimating() || introPlaying || pointer held
  twinkleDue = twinkle tier && sky view && stars visible && ≥ 29 ms since the last frame   // ~30 Hz
  held = governor.probe()                        // before a step with no fresh cadence: frames off to measure it
  ssIdle = supersampling tier && !motion && !dirty && !twinkleDue && history below the cap
  if !held && ssIdle:
      rc.render({jitter, weight})                // an extra sample only: no updates, labels or governor
  else if !held && (dirty || motion || twinkleDue):
      dirty = false                              // cleared first: invalidate() during update requests the next frame
      module.update(fi) for every module         // fi: dt, time, camera, viewMode, skyBlend, snap, pulses, simRate, exposure, mapK, map, systemBlend
      rc.render(ss);  labelsFeed.sync(camera, mode, view);  labels.update(camera, viewport, {cap, skyLum})
                                                 // ss: null (motion), a fresh history, or a drift/twinkle sample
                                                 // mode: labelMode(skyBlend, mapK, systemBlend) → orbit | sky | map | system
      governor.sample(dt) if the previous frame also rendered
  else:
      governor.idle(dt) if the previous tick drew nothing either    // the display cadence
  requestAnimationFrame(frame)                   // stops while the tab is hidden; resumes dirty
```

- **Render on demand.** Live at 1× redraws about twice a second, when the snapshot goes stale. A
  paused, idle app draws nothing. A module that animates, such as a texture swap, the launch tween
  or a pulse fade, calls `rc.invalidate()`. `rc.onInvalidate` is wired to `loop.invalidate()`.
- **Twinkle.** Star scintillation (High, sky view, no reduced motion) is the only ambient
  animation. It keeps frames coming only while the star field is actually shown (star exposure
  above `TWINKLE_MIN_STARS`, totality included, star layer on), and then at about 30 Hz whatever
  the display rate. A daytime sky view idles like the orbit view.
- **Idle supersampling.** Once nothing moves, the loop draws up to the tier's `supersample` extra
  frames, each jittered (Halton 2,3) and blended into a running mean, then idles: a paused app still
  goes quiet, a fraction of a second later. The first still frame after motion starts the history;
  Live 1×'s half-second snapshot steps join it as EMA samples while the view moved under ¼ px (see
  §4, Idle supersampling).
- **Strikes.** Every module call is guarded. A module that throws three times has its `object3d`
  hidden and stops being called, and one toast names the feature. A renderer that keeps throwing
  hands over to text mode through `onRenderFailure`.
- **No allocation.** One `FrameInfo` and one exposure object are reused. The option objects are
  frozen constants. Loops are indexed.
- **Redraw.** `loop.redraw()` draws one frame outside the cadence for `rc.capture`: the module
  updates with the current camera and the last `FrameInfo` (dt 0), the label feed's sync, then
  `rc.render()`; no DOM labels, stats or governor. `loop.labelOptions` exposes the label pool's
  per-frame options so a capture culls labels as the pool does.
- **Step.** `loop.step(now, dt, {before, after})` is one whole frame for a video session, whatever
  is dirty: the clock ticks at the caller's (virtual) `now`, the snapshot and readout follow, the
  rig advances by `dt`, then `before()`, the module updates, the label feed, `rc.render()` and
  `after(camera)`. The caller keeps the rAF loop stopped meanwhile.
- **Label cap.** Sky view uses the tier's `labelCap`. Orbit view caps at 18 to keep the globe clear.
- **Label mode.** `labelsFeed.sync` gets 'sky' past half the sky blend, 'system' past half the
  orrery's crossfade (`fi.systemBlend`), else 'orbit'.
- **Sky site.** `main.js` keeps the observer's light pollution (`astro/skyglow.js` `siteFor`: Auto from
  `cities.list`, or the Sky darkness setting) and hands it over with `loop.setSkySite(site)` on every
  observer, setting or city-index change. The loop fills `snap.skyglow` after each snapshot, headless
  too, so the Sky panel's "Bortle 8 · limiting mag 4.1" works in text mode. `fi.exposure` gains the
  sky term (zenith limiting magnitude) and `vision` (the night-vision weight, sky view only), which
  the sky module passes to `rc.setVision`.
- **Aurora.** `main.js` hands the Aurora activity setting (`display.aurora`) to
  `loop.setAuroraActivity`, and the loop fills `snap.aurora` next to `snap.skyglow` (headless too,
  for the Sky panel's "Under the aurora oval" line). The curtains move with simulated time only (the
  phase in `snap.aurora`), so they add no frames of their own: at Live 1× they step with the
  half-second snapshots, which is imperceptible at their drift speed. `fi.simRate` (the clock's
  rate while playing, else 0) lets them drop their fine structure at fast time-lapse rates, where it
  would only flicker. With reduced motion the phase is frozen.

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
3. Add `create('foo', …)` next to the others. The order of that list is the update order. Pass
   `furniture` as the third argument for observer furniture that a vantage point hides (beams,
   pin, medallions, trails, the eclipse ribbon, the flare live there).

It then receives layers, selection, tier and view changes, and its failures are contained.
A module may draw nothing at all: `long-exposure.js` has an empty group and is a module only for
`update(fi)`, which runs right before `rc.render()` on every rendered frame (it is created after
the rig, which it reads).

The render order is fixed in SPEC §E.1. From back to front:

- −100: Preetham dome
- −90: Milky Way
- −80: grids and constellation lines
- −70: stars
- −60: Sun, planets, trails
- −58: the angle ruler
- −50: ground and haze
- 0: Earth and Moon
- 10: clouds
- 15 and 16: the eclipse path ribbon and its umbra marker (above the cloud shell, no depth write);
  15 is also the aurora's limb-curtain shell (High and Max: FrontSide r = 1.05, additive, depth
  test on, no depth write; the march stops at the 90 km shell, so the planet is clipped analytically)
- 20: atmosphere
- 30 and 31: beams, normal and x-ray
- 33: planet medallions (`render/planets.js`, depth-tested, over the beams that end in them)
- 40: pin
- 50: flare
- then, after the whole main scene, the overlay scene (the orrery, `rc.setOverlay`): its depth
  cleared, nothing depth-tested; orbits 0, the retrograde figure 1, sight lines 2, the Sun 3, sprites
  4, edge arrows 5. Through the composer it is drawn before the bloom, so its Sun glows.

**Sky view draws apparent positions.** Every at-infinity shader goes through `infinityClip`, which
lifts the direction by refraction (`REFRACT_CHUNK`, `shaders/sky.glsl.js`) when its material sets
`uRefrUp` (the zenith) and `uRefrK` (the view blend). A module shares one pair of uniform objects
across its materials and sets them in `apply`/`update`. Materials compiled to the same program must
all declare both, or one inherits another's lift: `createLineLayer` always does (the alt-az grid
with strength 0). The Moon's vertex shader lifts each vertex about the camera, `DISC_FRAG` flattens
the Sun, and JS uses `astro/photometry.js liftByRefraction` wherever a direction becomes a screen
position or a horizon test (labels, picking, the flare).

**Planet medallions.** `render/planets.js` is created after the beams, so it reads the label anchors `beams.update` has just placed. It reports each medallion's footprint with `beams.setFootprint(id, halfW, halfH)`, and the labels feed passes it to the label pool as `med` (the label's dot becomes the medallion's eyepiece ring and is measured with the label). Beam labels therefore de-overlap with the medallion included, and a medallion fades with its label (`labels.isShown`). The impostor is one fragment function, `planetShade` in `PLANET_CHUNK`, in the frame of `astro/disc.js`; a true-scale consumer (a sky-view telescope zoom) fills the same per-instance pole/prime/light with `writeDiscInstance(st, cameraUp, …)` and the moon uniforms with `writeJupiterMoons(snap, frame, uniforms, false)`. The Details card's eyepiece (`ui/eyepiece.js`) ports the same shading to a 2D canvas (`js/ui` never imports `js/render`), redrawn only when its key changes.

**Depth far from the Earth (vantage points).** From 60 or 235 R a near plane of ≤ 0.05 leaves a
24-bit depth buffer 0.004–0.07 R coarse, worse than the 0.006 R cloud gap. In a vantage (and its
flights) the rig sets the near plane to 0.8 of the distance to the nearest drawn surface
(`vantageNear`: the 1.06 R aurora shell, or the Moon), keeping the Earth's shells 10⁻⁵ R apart.
Close to the Moon (`moonInFront`: within 8 R and nearer than half the Earth's distance) the Moon
is left out of that: `FrameInfo.moonFront` tells `render/bodies.js` to pin the Moon's clip depth
just past the near plane (`MOON_VERT uNearZ`: clipped at the eye, in front of everything), paint
its depth pass black so the Earth behind the limb is covered, swap in a 384-segment sphere (the
64-segment limb shows facets from 150 km up), dim the surface (`MOON_FRONT_GAIN`) and add a
procedural close-up relief (`moonRelief`: albedo mottle and a derivative bump). One pass, so the
low tier's direct path works too. The loop treats lunar orbit like a telescope-narrow sky view:
the frame snapshot follows every change of sim time and frames keep flowing while the clock runs.

**One horizon.** `main.js` creates a single `geo/horizon.js` profile and hands it to the ground
(which builds it once per observer change, from the city list and the ocean mask read back
through a small canvas, and uploads it as a float texture), to the bodies (picking), the flare and,
through `loop.attach`, to the labels. With the landscape layer on they all test the same
silhouette, so a body behind a hill is neither drawn, labelled as up, clickable nor flaring.

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
  unoccluded point of the beam. In sky view it is the direction at infinity, with the label dot on
  the upper-right diagonal just outside the glyph, the Sun or Moon disc (the larger one in a solar
  eclipse) and the selection reticle, recomputed each frame from the zoom (`bodyLabelOffsets`). It
  reads NaN until the beam lands, so labels appear as the launch completes.
- **Below the horizon** (`is-below`): the snapshot's refraction- and limb-aware `above`, like the
  beams and the Sky panel, in both views (sky view draws bodies refracted). In sky view with the
  landscape on, the apparent upper limb is tested against the shared horizon profile instead
  (`labelBelow`). Direction anchors (and the beams' points at infinity) are lifted by refraction in
  `labels.js` as they are projected; the cardinals are not, they mark the horizon itself.
- **Orbit view** adds the observer label at the pin head and N/E/S/W on the horizon-disc rim.
- **Sky view** adds the cardinal points just above the horizon, bright star names (mag ≤ 2.5) and
  constellation names.
- **Daylight.** Star names follow their own star: `photometry.starVisibility` mirrors the star
  shader's fade, so names leave at dawn and return one by one at dusk or in totality (with
  hysteresis, `is-faint` while dim). Constellation names need a star-field exposure of about 0.3.
  The feed sets these flags in `sync()`, every frame, without rebuilding. `labels.update` gets the
  sky brightness (`photometry.skyBrightness`) and writes it as `--sky-lum` on `#labels-root`. The
  dark text halo softens with it, and from 0.6 (`is-daysky`) labels switch to dark text on a light
  halo.
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

| | Low | Medium | High | Max (manual only) |
|---|---|---|---|---|
| DPR cap | 1.0 | 1.5 | 2.0 | none (the device's own; GPU render-buffer limit still applies) |
| Composer / MSAA | none (context antialias) | yes / 4 (0 + FXAA on touch) | yes / 4 | yes / as many as `MAX_SAMPLES` allows (FXAA if that is 0) |
| Bloom | none | 0.55 / 0.4 / 0.9 @ ½ res | 0.6 / 0.45 / 0.9 | as High (full resolution) |
| Earth | 64×32, `day2k` + `night2k`, 2k roughness mask, no clouds | 96×48, `day4k`, 2k roughness mask, 2k clouds | 128×64, `day4k`, 4k roughness, 4k clouds + shadows + bump | 256×128, `day8k` + `night8k` + `clouds8k` (4k first), 4k roughness + bump, soft 5-tap cloud shadows |
| Clouds (sculpted) | — | relief, Beer-powder, silver lining, erosion | as Medium + self-shadow march | as High, relief from the 8192 map |
| Night side | moonlight, close-zoom lights | + moonglint | + moonglint | + moonglint |
| Aurora | face-on oval | face-on oval | + limb-curtain shell (24 samples) | + shell (48 samples) |
| Moon map / anisotropy | 1k / 8× | 1k / 8× | 1k / 8× | `moon4k` (1k first) / 16× |
| Atmosphere | analytic | analytic | ray-marched (8 steps) | ray-marched (32 steps) |
| Stars to mag | 5.0 | 6.0 | 6.5 | 6.5 (the whole catalog) |
| Flare / twinkle | — / — | ✓ / — | ✓ / ✓ | ✓ / ✓ |
| Idle supersampling / streak cap | — / — | 8 samples / 14 px | 16 / 24 px | 16 / 32 px |
| Labels | 12 | 24 | 40 | 80 |

- **Choosing the tier.** `detectTier` uses the renderer string, touch input, device memory, max
  texture size and Save-Data. Software renderers get Low. Touch devices are capped at Medium.
  Discrete GPUs get High. Auto never picks Max (`isAutoTier`).
- **Max.** "No budget": Settings → Quality → Max, `#q=max`, or a saved choice. It is always pinned,
  so the governor never touches it. Its 8192 px Earth maps and 4096 px Moon load only on Max, after
  the 4096 (and 1024 Moon) maps of the same imagery (`INTERIM` in `textures.js`), which show
  meanwhile; so Max is ready as fast as High and sharpens in place. A GPU that cannot take a knob
  loses that knob only (`tierConfig`): under 8192 px it keeps the 4k Earth maps, under 4096 the
  4k-only features, and postfx clamps MSAA to the context. The service worker never precaches them;
  they are cached cache-first on first use, so Max works offline after one visit.
- **Switching.** Settings and `?q=` pin a tier. Auto lets the governor step down, never up. If the
  frame-time EMA stays above 1.3 × the budget for 2 s, it lowers the DPR by 0.25 and then drops a
  tier, with a 5 s cooldown. Under `navigator.webdriver` the governor is never sampled.
- **Budget.** 16.7 ms (33.4 ms on touch), or the display's own frame interval when that is longer:
  the median of rAF ticks that drew nothing after a tick that drew nothing (`governor.idle`), so a
  30 Hz Energy Saver cap or a 48 Hz panel does not read as a slow GPU. Idle ticks over 50 ms are
  a stalled main thread (a janky boot) and never count. When a step is due and the cadence is
  unknown (the intro renders from its first frame) or stale (no idle tick in 5 s of rendering: a
  cap that starts during a time-lapse), the loop holds up to 8 frames back (`governor.probe()`)
  to measure it afresh, at most once per 5 s of rendering and never on the floor. If that raises
  the budget, the 2 s over it start again.
- **Learned tier.** A tier drop is saved in prefs (`qualityLearned`: tier, renderer string, time).
  For 30 days the same GPU starts Auto at that tier instead of the detected one (`autoStartTier`),
  so it does not pay the switch hitch on every visit. "Reset all settings" forgets it.
- **Anti-aliasing.** Without MSAA on the scene target (touch Medium) the target keeps a depth
  texture and the final pass runs FXAA on tone-mapped taps, but only across depth silhouettes (the
  Earth's limb, the Moon, the pin). Stars, lines and beams are anti-aliased where they are drawn
  and write no depth; FXAA would turn a small star into an X. A context created for a composer
  tier has no canvas MSAA, so a later switch to Low keeps a lean chain (no bloom, no MSAA, FXAA)
  instead of the direct path. A Low boot keeps the direct path even if the driver refused MSAA.
- **Applying a tier.** `applyTierCfg` calls `rc.setTier` and each module's `setQuality`, then loads
  the tier's textures. The scene graph is never rebuilt.
- **One planet on every tier.** The 2k maps are the 4k maps at half size, made by
  `scripts/build-textures.mjs`: `day2k` and `night2k` from the day and night maps (filtered in
  linear light, like the GPU's own mip 1), and `clouds2k` and `roughness2k` from the blue (cloud)
  and green (water) channels of `brc4k`. The shader reads both cloud maps through one density
  curve and both water masks through one window. A Settings change or a governor step therefore
  changes sharpness and effects, never the colours, the coastlines or the weather. The night map
  follows the day map (`nightKeyFor`), so medium on a GPU under 8192 px also gets `night2k`.
- **Every tier loads a water mask.** Low loads the 56 KB `roughness2k` that medium uses. The
  mask the shader can derive from the day map (blue over red) is only a stand-in while the mask
  loads. It runs on chroma, which lossy WebP and JPEG store at half resolution, so it reads most
  islands a few texels wide as sea and they vanish under the sun glint.
- **Known limit of the 2k maps.** Lossy WebP always stores chroma at 4:2:0, so isolated city
  lights in `night2k` are less saturated than in the 4k map. They are paler and whiter-yellow,
  with the same brightness. The shader's orange tint hides part of it. For the same reason,
  islands a few texels wide in `day2k` take on some of the sea's blue. They keep their shape,
  because the water mask comes from `roughness2k`. Encodes that keep the
  chroma cost 2.5 to 9 times the 75 KB: 4:4:4 JPEG is 190 to 700 KB and lossless WebP about
  434 KB.

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
| `webglcontextlost` | Rendering pauses (the panels keep updating) and a non-blocking "Graphics were reset — restoring…" overlay appears. On restore, `textures.restore()` runs, the context drops the old composer unreleased (its GL objects died with the lost context) and builds a new one, and rendering resumes. |
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
 &view=orbit&lock=1&sel=moon&ly=bgoscCnmkazhld&q=auto&sky=auto&cam=o:21.0,105.8,3.2&intro=0&debug=1
```

- No `t` means Live.
- `r` is the signed rate in sim-seconds per second, snapped to the ladder.
- `ly` is the exact set of enabled layers. `d` is the illustrative landscape: links made before it
  existed carry no `d`, so they open with the flat horizon.
- `cam` is `o:lat,lon,dist` (the sub-camera point), `s:az,alt,fov` or, with `view=map`,
  `m:lat,lon,dist` (the map's centre and the camera's distance from the plane). An orbit distance
  past 150 R (up to 80 AU, whole radii) is the solar-system zoom: lat/lon is then its direction
  (pivot → camera) in J2000 ecliptic latitude and longitude, fixed in space, so a live link opens
  on the same view later.
- `loc2`, `n2`, `tz2` are a second place to compare with (its pin, dashed beams and Sky now's
  side-by-side card). They are links only, never saved.
- `sel` selects a body and opens its card (the Details tab), as a click on it would.
- `sky` is the Sky darkness setting (`display.skyDark`): `auto` (omitted), `pristine` or a Bortle class `1`–`9`.
- `au` is the Aurora activity setting (`display.aurora`): `quiet`, `typical` (omitted) or `storm`.
- `tour` starts a guided tour (`tonight`, `year`, `eclipse-2027`, `ambient`) once the app is ready,
  instead of the intro. It is read, never written: the hash shows the restored state afterwards.
- `trk` is sky-view tracking: `b` (the selected body) or `s` (the stars).
- `vt` is a vantage point: `l1` or `moon` (globe view only; `cam` is then the orbit pose it returns
  to). A link opens straight there; the Earthrise orbit is planned at the link's time, so the Earth
  stands just over the limb.

`bindUrl` writes the hash at most every 500 ms and leaves a fresh visit's URL clean. Hand edits
are applied live through `onExternalChange`. It writes nothing while a tour plays.

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
  1 day/s. A `--url` with `sel=` must open the Details tab, and with `--mobile` the time-bar date
  and time must fit unclipped on 14 consecutive days (every weekday, one- and two-digit days).
  Useful flags: `--mobile`, `--tz=UTC`, `--reduced-motion`, `--subpath=/repo/`,
  `--url=/#…`, `--out=shot.png`, `--eval="js"` (awaited before the screenshot). For the failure
  matrix and the intro: `--no-webgl` (text mode), `--init="js"` (runs before the page, e.g.
  `HTMLScriptElement.supports=()=>false` for no import maps), `--fail=data/sky.json,earth_day`
  (those requests get HTTP 404 and are not judged) and `--at=1000,3000` (timed screenshots
  `<out>-<ms>.png`; the run then skips its wait for the intro to finish).
- **`npm run size`** enforces the per-tier transfer budgets (low 3.76 MB, medium 4.52 MB, high
  8 MB raw, re-baselined from the spec's estimate to the measured unminified module graph; low and
  medium stay under 6 MB, high under 8 MB) and the 32 MB deploy limit. Max (≈ 20.8 MB) is reported but has no budget;
  its 8192 px maps (≈ 15.2 MB) are why the deploy limit went from 12 to 32 MB (the staged site is
  ≈ 21.6 MB; GitHub Pages allows 1 GB).
- **`npm run textures`** (`scripts/build-textures.mjs`) re-encodes the derived textures in headless
  Chrome and rewrites `vendor/DERIVED.json`. Run it after changing a recipe or a source map, and
  review the result visually. `--check` (in CI) compares hashes only, with no browser, because
  JPEG and WebP encoder output differs between Chrome versions. The vendored upstream files stay
  in `vendor/VENDOR.json` with their upstream hashes. `--only=8192,moon_4096` rebuilds just the
  matching outputs and keeps the other lock entries. The Max maps' 8192 px sources (Solar System
  Scope's cloud map and Moon, 25 MB) are `cache` entries in `vendor/VENDOR.json`: gitignored under
  `data/raw/textures/`, downloaded by `npm run vendor`, verified when present and skipped by
  `--check` when not (the derived outputs' own hashes are still checked).

## 12. Conventions

- Modern ES2022 modules, 4-space indent, semicolons, single quotes, `const` by default.
- JSDoc on every export. Comments explain *why*.
- No TypeScript, no bundler, no npm runtime dependencies.
- No module throws at import time.
- Render-module constructors tolerate placeholder textures and an empty catalog.
- A healthy boot logs one `console.info` line and nothing else. The smoke test fails on console
  errors.
- Product copy in JavaScript uses `APP_NAME` from `js/version.js`.
