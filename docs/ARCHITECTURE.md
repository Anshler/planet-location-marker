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
   ├─ js/core/    app state: store, bus, clock, url-state, prefs, tz, format, quality,    PURE
   │              texture-plan, context-loss, diagnostics, i18n (strings and Intl)
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
| Entry | `index.html` | Import map (`three`, `three/addons/`). `modulepreload` for the whole boot graph (generated; §3 'Early downloads'). Preload for `data/cities.json`. Inline loader. Classic scripts for error capture (`window.__pcLoader`) and feature detection (`window.__pcEnv`), which also preloads three.js, the render stack and the Earth previews when the 3D view can run. |
| | `js/main.js` | Boot sequence, service wiring, store-to-module subscriptions, click picking, tier switching, the intro runner, the guided-tour loader (`startTour`), `window.__app`. |
| | `sw.js` | The service worker (classic script; §9 'The service worker'). In the repo it is the dev worker (network first); the deploy stamps a content-hashed `VERSION` into its staged copy, which installs each version atomically from `sw-manifest.json`. |
| App glue | `js/app/actions.js` | `createActions(deps)`: the only API the UI calls besides `store` and `clock` (read-only queries too, such as `getView()`, the camera's field for the Sky dome, and `shareUrl({event})`, a link to an event's sky). Also `normalizeObserver`, `eventFraming` (how a jump frames its event), `eclipseFocusExpired`, `eclipsePlayRange` and `lookSpanning`. |
| | `js/app/mars-host.js` | `createMarsHost(deps)`: standing on Mars (loaded by `main.js bindHost` the first time `store.host` is Mars). `enter()` hands the loop a Mars snapshot source (`loop.setHost`), broadcasts `setHost('mars')`, hides the Earth-only groups (`R.earthGroups`), registers the `sat:` provider and adds `render/mars-sky.js` once a renderer exists; `leave()` undoes it. No three.js. |
| | `js/app/eclipse-chase.js` | `ribbonPlan` (which eclipse the globe's path ribbon shows), `chaseLegs`/`chaseTarget` and `createEclipseChase` (the shadow chase behind `actions.chaseEclipse`). No three.js. |
| | `js/app/loop.js` | `createLoop(deps)`: the frame loop with render-on-demand, guarded module calls and strikes, governor sampling, the 4 Hz readout and idle supersampling (extra jittered frames once nothing moves, `core/sampling.js`). `redraw()` draws one frame on demand (captures); `step(now, dt, io)` runs one whole frame on a caller's time base (video sessions). |
| | `js/app/tier-switch.js` | `createTierSwitch(hooks)`: the staged tier switch's sequencing (pause, stage, compile, commit, resume; DPR steps at once; a newer request replaces a staged one; a 10 s cap), driven by `main.js makeTierSwitch` (§8, Applying a tier). No three.js. |
| | `js/app/capture.js` | `createCapture(deps).frame(opts)`: the scene rendered once at a requested size into a 2D canvas, with the label feed's labels reprojected for that camera (`projectAnchor`, `projectLabels`, `paintLabels`). Postcards and the long exposure's Save image. `session(opts)`: the same, frame after frame at one size (the time-lapse video). No three.js. |
| | `js/app/recorder.js` | Time-lapse video export, loaded on demand by `actions.recordVideo`: the pure frame plans (`videoPlan`: holds and clock ranges for a day, a night of star trails, the 2027 eclipse chase; `nightSpan`), `pickEncoder`, and `recordVideo` (deterministic frames on a virtual time base, WebCodecs into `mp4.js`, else MediaRecorder in real time; state restored afterwards). No three.js. |
| | `js/app/mp4.js` | A tiny faststart MP4 muxer for one H.264 (`avcC`) or VP9 (`vpcC`) track, pure; `mp4Boxes` walks boxes (tests). |
| | `js/app/expose.js` | Long-exposure presets, pure: `photoLayers` (no line art in a stack), `trailsLook`, `nextDarkMs`, `meanNoonMs`, `analemmaPlan`. |
| | `js/app/labels-feed.js` | `buildAnchors(state, snap, catalog, trails)` and `createLabelsFeed(deps)`: label anchors with live vectors. |
| | `js/app/intro.js` | `playIntro(opts)`: the first-visit camera flight, pin drop and beam launch (after a pre-roll that holds the opening pose while the loader fades). The launch is emitted as bus `'intro'` `'launch'` (the UI's title card); a skip never emits it. |
| | `js/app/tours.js` | Guided tours, loaded on demand: the pure step builders (`tonightSteps`, `yearSteps`, `eclipseSteps`, `ambientSteps`) and `createTourRunner` (captions, pause/resume/next, state capture and restore). No three.js. |
| | `js/app/fallback.js` | Text-mode banner (with Retry after repeated context losses), context-lost overlay, fatal-error hand-off. |
| | `js/app/sw-client.js` | `createSwClient(deps)`, imported at idle time: registers `sw.js` (`swMode`: https hosts, or `#sw=1`; `#sw=0` unregisters), the "A new version is ready · Reload" toast, the first visit's warm-up, and the state behind `__app.sw`. No three.js. |
| | `js/app/session.js` | `sessionStorage`, guarded (`sessionLoad`, `sessionSave`): this tab's context-loss record outlives a reload, not the tab. Saved preferences stay in `core/prefs.js`. |
| | `js/app/wake-lock.js` | `createWakeLock({nav, doc, win})`: the one screen wake lock, held while any named reason holds it (`'red'` night vision, `'sky'` the sky view on a touch-first device, `'aim'` 'Point at the sky') and the page is visible; asked again when the page shows, quiet on a refusal, let go after 20 min without a tap or key. `R.wake` in `main.js`. |
| | `js/app/extras-setup.js` | `registerExtras(extras, {fetchJson, onDso})`: registers the guest-star and comet providers at boot, the spacecraft once `data/craft.json` arrives and the deep-sky objects once `data/dso.json` does; `registerStars(extras, {getCatalog, fetchJson})`: the catalogue-star provider once `sky.json` is decoded, following the selection and fetching `data/starinfo.json` on the first star (§4, Extra objects). |
| Core | `js/core/store.js` | Immutable slices, selector subscriptions, `DEFAULT_STATE`. |
| | `js/core/bus.js` | Fixed event types: `readout`, `toast`, `announce`, `almanac`, `events`, `intro` (`'start'`, `'launch'`, `'done'`). |
| | `js/core/clock.js` | Simulated time: Live mode, the signed rate ladder, steps, log-time tweens, range loops, clamping to 1000–3000. |
| | `js/core/url-state.js` | `parseHash`, `serializeHash` and `bindUrl`, which keeps the URL hash in sync (throttled `replaceState`; held while `suspended()`, i.e. during a tour). |
| | `js/core/tour-catalog.js` | `TOURS` (id, title, blurb, running time), `TOUR_IDS`, `isTourId`: what the Events tab lists and `#tour=` accepts. |
| | `js/core/selection.js` | What `store.selection` may hold: a BodyId or a namespaced extra id (`EXTRA_KINDS`, `isExtraId`, `isSelectionId`, `parseSelectionId`, `normalizeSelectionId`). |
| | `js/core/moments.js` | `MOMENTS` (famous skies as deep links: caption, sources, hash) and `FAMOUS_COMETS` (Halley's five apparitions), listed by the Events tab. |
| | `js/core/quality.js` | `TIERS`, `detectTier`, `tierConfig`, `autoStartTier`, and `createGovernor` (downgrade only, display-cadence budget; `lastStep` keeps each step's EMA and budget for the diagnostics). |
| | `js/core/context-loss.js` | The context-loss backoff (§9): `recordLoss` (a 60 s sliding window: restore, then one tier lower for the session, then text mode), `retryRecord`, `capTier`, `tierBelow`. |
| | `js/core/diagnostics.js` | `buildDiagnostics`: the 'Copy diagnostics' report (§11), with no location: `diagHash` keeps an allowlist of hash keys, `scrubError` cuts URL fragments, queries and `loc=` pairs from error lines. |
| | `js/core/sampling.js` | Renderer policies, pure: `halton`, `createSupersampler` (idle supersampling: which frames accumulate, their weight and jitter, when to park), `viewMotionPx`, `streakShutter` and `strobeDim` (fast-time streaks). |
| | `js/core/prefs.js` | `localStorage` under `pc2.`, falling back to memory. |
| | `js/core/texture-plan.js` | Which images each tier loads: `ASSETS` (URLs, bytes, colour space), `INTERIM` and `PREVIEW` stand-ins, the per-slot key choices and `keysForTier` (critical previews, primary day and night maps, deferred rest); `download`/`prefetchTextures`, the early streamed fetches `main.js` starts before the render stack exists. No three.js; `render/textures.js` re-exports it. |
| | `js/core/i18n.js` | The interface's language (§12 'Strings and locales'): `t`, `tn`, `N_`, `setLocale`, `locale`, `pickLocale`, cached `intl()` formatters, `dec`, and `dateText`/`timeText` (wall-clock fields → the locale's date and time). |
| | `js/core/tz.js`, `js/core/format.js` | Time zones (canonicalised, DST-safe) and every displayed number and string, in the interface's locale. Calendar dates before 15 Oct 1582 are shown Julian (`toCalendar`, `fromCalendar`, `parseCalendarInput`, JDN helpers); instants and `t=` stay Gregorian UTC. |
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
| | `js/astro/almanac.js`, `events.js`, `paths.js` | Rise/set, twilight, Tonight (with `series`, the 10-min noon-to-noon altitudes behind the verdicts), `altitudeSeries` (any body; the time bar's strip and bands); events (with eclipse contacts, `localSolarEclipseAt`; Phase 6: Moon–star occultations of five hard-coded J2000 stars `OCCULTATION_STARS`, Venus at greatest brilliancy, transits, the year's perigee/apogee extremes and perigee full Moons, Saturn's ring-plane crossings, meteor-shower maxima; transits and apsides cached across calls); retrograde paths. |
| | `js/astro/meteors.js` | Meteor showers, pure: the IMO calendar table `SHOWERS` (with `validFrom`/`validTo` years), `precessionDeg` and `showerPeakMs` (λ☉ J2000 + precession → AE.SearchSunLongitude), `zhrAt`, `radiantAt`, `hourlyRate`, `meteorLimitMag`, and the deterministic generator (`BUCKET_MS`, `hash01`, `poissonCount`, `meteorShape`, `sampleMagnitude`). |
| | `js/astro/planner.js` | The year planner, pure: `visibilityYear` (365 nights × 15:00–09:00 standard time: the Sun's, the Moon's and each planet's altitude, magnitudes, elongations; analytic altitudes from one RA/Dec a night), `plannerVisible`, `plannerSummary`. Worker op `visibilityYear`. |
| | `js/astro/sunpath.js` | `sunFigures`: today's, the solstices' and the March equinox's Sun paths (local ENU, apparent), rise/set azimuths, the noon analemma, the subsolar figure-8 at the current UT time of day. Worker op `sunFigures`. |
| | `js/astro/eclipse-path.js` | `eclipsePath`: the centre line and limits of a central solar eclipse; `citiesInPath`, `nearestCentrePoint`, `pathAt`, `shadowPoint`. Render support: `ribbonMesh` (the globe's ribbon, once per eclipse), `pathFrameLocal` (the shadow and its heading, allocation-free), `shadowAxisPoint`, `umbraNear`. |
| | `js/astro/worker.js`, `client.js` | Module worker plus a Promise client with a main-thread fallback. Typed arrays in a result, down to three levels of plain objects, are transferred (`transferablesOf`), so a result never hands out a typed array the worker keeps. |
| | `js/astro/parallax.js` | `compareSight(snapA, snapB, i)`: a body seen from two places at one instant: the angle between the two sightlines, the baseline and the distance they imply (the Moon's parallax). |
| | `js/astro/shadow.js`, `photometry.js` | Eclipse disc overlap; B−V colour, refraction (and `liftByRefraction`, the sky view's drawn positions), airmass, limiting magnitude, adapting luminance (night vision), exposure. |
| | `js/astro/skyglow.js` | The night sky's own brightness: KS91 moonlight, van Rhijn airglow, Walker's-law light pollution from `data/cities.json` (16-bin azimuth dome), SQM, Bortle, limiting magnitude; `computeSkyglow` fills `snap.skyglow`. |
| | `js/astro/disc.js`, `moons.js` | A body's disc as seen from the observer: the sky-plane frame and pole/prime meridian/Sun in it (`discFrame`, `discView`), shapes, Saturn's ring radii, the moons' log spacing; Jupiter's Galilean moons at Jupiter's light time with transit/occultation/eclipse/shadow flags (`computeGalilean`), the libration's limb feature, Saturn's next edge-on run. Shared by the medallions and the eyepiece card (ASTRONOMY.md §4). |
| | `js/astro/geomag.js` | The IGRF centred dipole (1900–2030, held outside) and the Starkov auroral ovals for an activity setting (quiet / typical / storm = Kp 1 / 3 / 7, never live data); `computeAurora` fills `snap.aurora` (pole, magnetic noon, the 48-float boundary table, the animation phase); `auroraText` for the Sky panel. |
| | `js/astro/totality.js` | Totality from the ground: Baily's beads (lunar limb profile), corona epoch parameters, contact-time display adaptation, the horizon ring's azimuthal shape. Illustrative in detail (ASTRONOMY.md). |
| | `js/astro/orrery.js` | The solar-system zoom, pure: the crossfade (`systemBlend`, 80 → 150 R), the camera's pose (`systemPose`: pivot sliding from the Earth to the Sun, ecliptic direction, `liftLat`), the orbit polylines (`orbitPolylines`, the worker's `orbits`), the retrograde figure's sight lines (`sightAt`, `sightLines`, `sightStepMs`) and the edge arrows' place (`edgeExit`). |
| | `js/astro/vantage.js` | Vantage points (loaded by the rig on first use): the L1 pose (235 R sunward, 4° toward ecliptic north, north up, 0.7°), the Earthrise orbit (`planLunarOrbit`: 150 km up, in the plane through the Earth direction nearest the ecliptic, rising over the sunlit limb; `lunarOrbitPose`: the orbiter's place at any time, looking along its track), `vantageFov`, `vantageNear`, `moonInFront`. |
| | `js/astro/extras.js` | The extra-object registry (`createExtras`): providers per kind, `fill(snap)` → `snap.extras`, `state`, `meta`, `card`, `onChange`; `topocentricScene`, `extraAltAz`, `extraSky` (§4, Extra objects). |
| | `js/astro/host-mars.js` | Standing on Mars: `computeMarsSnapshot(t, site, out, opts)` fills a Snapshot for an areographic site (slot 4 = the Earth, `snap.mars`), `marsMoonPosition` (Phobos and Deimos from mean elements), `createMarsMoonsProvider` (`sat:` extras). Loaded on demand (app/mars-host.js). |
| | `js/astro/mars-clock.js` | Mars time (Allison & McEwen 2000 / Mars24: MSD, MTC, LMST, LTST, Ls, EOT, the solar declination), the landing sites, mission sols, `marsClockText` ('Sol N · hh:mm LMST'), `marsSunAltDeg`. |
| | `js/astro/guest-stars.js` | The five naked-eye supernovae of 1006–1604 (`GUEST_STARS`, remnant positions, records), `guestMagnitude` (light-curve templates), `guestRiseSet` (AE `DefineStar` on `Star8`), the 'guest' provider. |
| | `js/astro/comets.js` | Halley's Comet at its 1066, 1456, 1910, 1986 and 2061 apparitions: Kepler solvers (elliptic, hyperbolic, Barker), `elementsB1950ToJ2000`, light-time geocentric positions, the magnitude law, tail geometry (`fillTails`), the 'comet' provider. |
| | `js/astro/sgp4.js` | Near-Earth SGP4 (Vallado 2006, WGS-72): `parseTle`, `sgp4init`, `sgp4`, `gstime`, `temeToEf`. |
| | `js/astro/satellites.js` | The ISS, Tiangong, Hubble and three Zenit stages from `data/tle.json`: `decodeTle`, `lookAt` (alt/az, range, Earth shadow, magnitude), `groundTrack`, the 'sat' provider (`fill` + per-frame `advance`), `satellitePasses`/`allPasses` (worker). |
| | `js/astro/craft.js` | Voyager 1 and 2, New Horizons, JWST from `data/craft.json`: `decodeCraft`, Hermite `craftStateAt` (straight-line 'projected' past the data), `radioTimeS`, `dsnInView`, the 'craft' provider. |
| | `js/astro/stars.js`, `lighttime.js` | Catalogue stars as extras (`star:<hip>`; one registry slot, for the star being looked at: `track(id)`): designations, Hipparcos distance, colour and luminosity words (`starKind`), distance from the pole of date; 'the light you see left …' (`parallaxDistance`, `departureLine` rounded to the distance's error, `HISTORY`, `lyWords`). |
| | `js/astro/dso.js` | Deep-sky objects from `data/dso.json`: `decodeDso`, `DSO_TYPES`, `dsoEffMag`/`dsoVisibility` (shared with the sprites), the 'dso' provider (glyph 'none', layer `deepSky`, labels for the naked-eye ones, `data.fovDeg` for the telescope). |
| | `js/astro/precession.js` | The time-machine sky: `poleOfDate`, `equinoxOfDate` (AE `Rotation_EQD_EQJ`), `poleTrack` (1000–3000), the illustrative circle `poleOnCircle`, `eclipticPole`, `POLE_STARS`, `equinoxConstellation`. |
| | `js/astro/sky-caption.js` | `skyCaption(snap)`: 'The sky you were born under' ('Jupiter was in Leo…; the Moon was 62% lit…'). |
| | `js/astro/sky-guide.js` | Finding it in the real sky: hands at arm's length (`handSpan`: a fist ≈ 10°, a finger ≈ 1°), `findIt` ('Face south-east, 4 fists up from the horizon, 1 fist left of the Moon.'), `guideRefs` (the Moon, bright planets and, by night, 24 bright J2000 stars as signposts), the ruler's numbers (`separationDeg`, `fmtAngle`, `rulerText`) and `edgeHit` (where an off-screen pointer meets the free area's edge). |
| Data | `js/data/catalog.js` | Decodes `data/sky.json` into GPU-ready typed arrays in the scene frame (with B−V and sky.json's own order, `srcHip`); `applyProperMotion(catalog, years)` moves the fast stars, their constellation endpoints and name labels in place; `mergeDeepStars` appends the max tier's `data/stars8.json`. |
| | `js/data/starinfo.js` | Decodes `data/starinfo.json` (parallax per star, proper names, Bayer and Flamsteed designations; `GENITIVE`, `designations`). |
| Render | `js/render/context.js` | Renderer, scene, camera, tier switching (`setTier`, or staged: `prepareTier` builds the post chain, `compile({paced})` warms every variant, `commitTier` applies the DPR), `invalidate`/`onInvalidate`, context loss (three's bookkeeping released while lost; drawing waits for the restore listeners' promises), stats; `setAccumulation` (long exposures), `capture` (a one-task render at another size), video sessions (`beginCapture`, `captureCamera`/`releaseCamera`, `endCapture`), `render(ss)` (a jittered supersampling sample; a shown overlay takes the same jitter) and `setOverlay` (a second scene drawn over the first with its own camera and depth: the orrery). |
| | `js/render/postfx.js` | Composer with bloom and the final pass (FXAA when the scene target has no MSAA; the night-vision grade, `rc.setVision`). An `OverlayPass` right after the scene draws the overlay scene (`setOverlay`). While Expose is on, `AccumPass` (`accum.js`: two half-float targets, max-stacking, bright-only for the analemma) sits between the scene and the bloom; otherwise, on tiers that supersample, `SupersamplePass` (`supersample.js`: one half-float history, a hardware-blended running mean) sits there. |
| | `js/render/streaks.js` | Fast-time star streaks, a render module for its per-frame hook: measures the camera's turn since the last frame and publishes `STREAK_UNIFORMS` (the shutter's opening as a world → view mat3, the cap), shared by the stars and the planet glyphs (`STREAK_VERT_CHUNK`), and `streakState.dim` for line art and the Milky Way. |
| | `js/render/orrery.js` | The solar-system zoom's orrery: its own scene and camera in AU (the overlay), orbits, the Earth→body sight lines the beams fade into, sprites lit by the Sun, the Sun on the bodies' `DISC_FRAG`, the retrograde figure for a selected planet, edge arrows; live label points (`labelPoint`, `labelOffset`) and `pick`. Shaders in `shaders/orrery.glsl.js`. |
| | `js/render/long-exposure.js` | The long exposure's controller, a render module for its per-frame hook: turns stacking on in sky view while `ui.expose` is set, resets the stack when the framing changes, gates star trails by daylight, reports `stats()`. |
| | `js/render/textures.js` | Placeholder-first texture store with byte-weighted progress. Takes over `main.js`'s prefetched downloads, shows a day or night map's 512 px preview while it loads (`state(key) === 'preview'`), and holds eager uploads while the shaders compile (`holdUploads`; a tier switch's `{bind: false}` hold binds a map only once it is on the GPU). `setAnisotropy(n, keys)` re-uploads through the hold. A decoded bitmap is closed once uploaded (not the ocean masks the CPU reads, nor the previews: ASSETS `keep`); `restore()` and a new anisotropy fetch a closed map again (§8, Decoded images). |
| | `js/render/earth.js`, `atmosphere.js` | Earth shader (day, night lights with close-zoom filtering, the sharpen-in from the 512 px previews, sun glint and moonglint, moonlight, twilight, sculpted clouds, the face-on aurora, eclipse shadow, footprint) and atmosphere. |
| | `js/render/aurora.js` | The aurora's limb-curtain shell (High and Max) and the driver of `AURORA_CHUNK` (`shaders/aurora.glsl.js`), whose uniforms the Earth and cloud materials also carry for the face-on oval on every tier. |
| | `js/render/skyglow.js` | Uniforms of `SKYGLOW_CHUNK` (`shaders/skyglow.glsl.js`), filled from `snap.skyglow`: the moonlit sky and the city light dome per direction, for the dome, ground, stars and Milky Way. |
| | `js/render/sky.js`, `bodies.js`, `ground.js` | Stars, constellations, Milky Way and grids; Sun (with totality's thin crescent, corona, chromosphere and prominences under `SUN_ECLIPSE`), planets and the true-scale Moon; sky-view dome and ground (totality's 360° horizon ring, the illustrative landscape and sea, twilight- and moonlit land). |
| | `js/render/planets.js` | Planet medallions: each orbit-view beam ends in a magnified (~26 px) mini-globe at its label anchor, drawn by the shared impostor `PLANET_CHUNK` (`shaders/planets.glsl.js`: oblate spheroid on the IAU pole, true phase, Saturn's rings and their shadows, Jupiter's moons and shadows; reusable at true scale via `writeDiscInstance`/`writeJupiterMoons`). |
| | `js/render/totality.js` | Baily's beads and the diamond ring: up to eight HDR point sprites at `snap.eclipse.beads` (the flare's starburst follows the brightest). |
| | `js/render/beams.js`, `pin.js`, `labels.js` | Signature beams, observer pin and horizon disc, DOM label pool. A second instance of each (`{second: true}`: `beams2`, `pin2`) draws the second place from `snap.second`: amber pin, dashed amber-tinted beams. The pin rides the map morph onto the map. |
| | `js/render/ruler.js`, `edge-chips.js` | The angle ruler (a great-circle arc between two tapped ends, fixed buffers, its reading as a `'ruler'` label); the off-screen pointers (a DOM chip at the free area's edge per findable body outside the field, a tap turns there). |
| | `js/render/trails.js`, `flare.js`, `debug.js` | Retrograde paths, procedural lens flare (six-spike starburst, hexagonal aperture ghosts; no textures), `?debug=1` overlay. |
| | `js/render/eclipse-path.js` | The path of a central solar eclipse on the globe: ribbon, centre line, 30-min ticks, the live umbra marker; reveal modes for the chase. |
| | `js/render/extras.js` | Extra objects at infinity: guest stars as points of the star field's own material (`sky.starMaterial`), hollow-diamond markers (spacecraft), the selected extra's ring; `pickCandidates()`. |
| | `js/render/mars-sky.js` | Standing on Mars (added by app/mars-host.js, loaded on demand): the Mars dome (`shaders/mars.glsl.js`: butterscotch day, blue aureole and twilight), Phobos and Deimos as true-size depth-writing discs, and the light-from-home beam to the Earth. |
| | `js/render/dso.js` | Deep-sky objects as faint, true-size procedural sprites (one instanced quad each, per-type profiles, structure only at zoom; `deepSky` layer) and `pick(tapDir, radPerPx)` inside an object's outline. |
| | `js/render/precession.js` | The `precession` layer: the pole's circle (illustrative), its 1000–3000 track with century ticks, live crosses on the pole and equinoxes of date; `anchors()` for the label feed (`getSkyMarks`). |
| | `js/render/comets.js` | A comet's coma (true angular size, 5 px floor) and its ion and dust tails, billboards at infinity through the tail samples. |
| | `js/render/satellites.js` | Satellites: globe dots, beams from the pin, the featured ground track; star-material points and a ring in sky view; `moving()` (the loop's liveMotion), `pickCandidates()`. |
| | `js/render/craft.js` | The spacecraft's radio beams: a small instanced set on the beams' shaders under `#define RADIO` (fine dashes, faint), from the pin, with the `spacecraft` layer. |
| Camera | `js/camera/rig.js`, `picking.js` | Orbit and sky-view camera, Earth-lock, fly-to tweens, `follow()` (the shadow chase), sidereal tracking, `setVantage()` (View from L1, Earthrise), the flat map (`setMode('map')`, `mapK`, `mapFrame`), the system zoom past 150 R (`setSystem`, `system`, `systemBlend`, `onSystemChange`), `frameSpan()` (the Earth–Moon framing), `setAiming()`/`setSkyAim()` (the phone steers the look); analytic globe, map (`pickMap`), glyph and map-point (`pickPoint`) picking. |
| | `js/camera/aim.js` | 'Point at the sky' (loaded on first use, no three.js): device orientation → the rear camera's direction and the screen's up in ENU (`deviceVectors`), a level look (`lookOf`), an adaptive vector low-pass (`aimFilterStep`), and `createAim` (sensor events, iOS compass learning, deadband, Align offset, idle and hidden stops; holds the shared wake lock's `'aim'` reason, `deps.wake`). |
| Data | `data/tle.json` | Two-line element sets of the six satellites (`scripts/fetch-tle.mjs`, CelesTrak); rewritten in the staged site by every deploy (daily), network-first in `sw.js`. |
| Data | `data/craft.json` | Spacecraft knots (TDB JD, 1e-6 AU, 1e-8 AU/day), built by `scripts/build-craft.mjs` from JPL Horizons; fetched after boot, precached by `sw.js`. |
| | `data/dso.json` | 140 deep-sky objects (`scripts/build-dso.mjs`; Messier from d3-celestial, the rest hand-entered); fetched after boot, precached. |
| | `data/starinfo.json` | Parallaxes and designations of the base stars (`scripts/build-sky.mjs` from `data/raw/hip2.json` and starnames); fetched on the first star selection, precached. |
| | `data/stars8.json` | The max tier's 36,367 deeper stars (`scripts/build-stars.mjs`, Hipparcos V 6–8); fetched only on max, cached on first use (not precached). |
| | `js/render/meteors.js` | Layer `meteors` (`r`, sky view): radiant rings with label anchors (`anchors()`, appended by the labels feed's `getSkyExtras`) for showers within 25 % of maximum, and illustrative meteors on a `METEOR` line layer: live (medium+, clock running, no reduced motion; launched as sim time passes each hash-seeded meteor, played for 0.3–0.8 s of wall time, launches capped at 2.5/s, frames requested only while a streak flies) or a static one-hour composite (paused or reduced motion, any tier). `stats()`. |
| | `js/render/sunpath.js` | Layer `sunPath` (`y`): today's path with hour ticks, the solstice and equinox paths and the noon analemma as line layers in the observer's ENU frame (sky view), and the subsolar figure-8 as a line on the globe (Earth-fixed); figures from the worker via `request(snap)` (main.js `requestSunFigures`), only while the layer is on. `stats()`. |
| UI | `js/ui/index.js` and its modules | Shell, top bar, time bar (its strip coloured by `sky-palette.js`, the sky's colours by the Sun's altitude; the Time popover: go to, stepping, loop, time zone, 24-hour clock, legend), the five panel tabs (`shell.js TABS`: Up now, Details, Events, Explore, Display; on the phone in the bottom tab bar), Up now (the plain-words summary with its ⓘ; the list; one Charts card holding `sky-dome.js`, the all-sky chart, or `tonight.js`, the dusk-to-dawn chart, which also draws the rows' 24-h sparklines; all also in text mode), Details (`body-card.js`: the verdict, at most four actions with a More menu, the Display switches, More positions and What these numbers mean; with `eyepiece.js`: the 2D-canvas eyepiece portrait, also in text mode; `year-planner.js`: The year ahead, the planets' 12-month chart on a 2D canvas and the Sun's solstice paths in words, from the worker, also in text mode), events (the calendar: the Moon/Planets/Eclipses/Meteors/Satellites/Seasons filters as a radiogroup, 8 weeks then 'Show the rest'; `event-glyphs.js`: each event's inline SVG glyph; `ics.js`: 'Add to calendar', the pure RFC 5545 builder and the file hand-off), Eclipse Companion (plain contact names, folding on the phone and while a playback runs in Sky view), the tour's lower third (`tour-bar.js`), Explore (`explore.js`: the guided tours, the sky you were born under, Moments and Famous comets, a second place, Stand on Mars), Display (`layers.js mountDisplay`: one disclosure per group, its summary carrying the group's live state, for the layer switches grouped by the current view, Quality, Sky conditions, Comfort with the Night vision switch, `actions.setNightVision`, Shift+N in `shortcuts.js`, before plain N, and About this app from `about.js`; then Replay intro and Reset all settings), help, toasts, shortcuts, announcer; the share menu, `postcard.js` (postcard and Save-image dialog, the typographic band), `video.js` (the time-lapse video dialog: presets, frame size, progress and preview, the burned-in date stamp) and `expose.js` (the long-exposure presets and the exposure's mode chip); the toolbar (`view-switch.js`: `[Globe | Sky | Map] [Tools] [Share] [⋯]`, menus built by `dom.js menu()`, the viewpoint, map, telescope and following chips); the status stack (`modes.js`: `ui.modes`, one chip per active mode, the shortcut flash, Esc's `exitTop`); the ruler's and pointing's chips (`sky-tools.js`); the body card's 'Find it' line; the second place (`Compare with…` in the place search); the place search's sky preview per result (`location.js placeSky`) and its In the sky section (`rankSky`); first-run onboarding: `intro-caption.js` (the intro's title card), `coach.js` (the three coach marks, `ui.showTips()`), `install.js` (About this app's Install group, ⋯ › Install the app and the one-time iOS hint), the help dialog's gestures and mouse (`help.js GESTURES`, `MOUSE`) and the ⋯ menu on every layout (`view-switch.js`) |
| | `js/ui/report.js` | About's 'Report a problem' (`mountReport`): Copy diagnostics (`actions.copyDiagnostics`; a selectable textarea when the clipboard is blocked) and `issueUrl()`, a new issue on `REPO_URL` with a short template. |

---

## 3. Boot sequence

`main.js` runs these steps. The network is never on the critical path.

1. **State.** The observer comes from the URL hash, then the saved preference, then the largest city
   in the device's timezone (`cities.byTz`, canonicalised; on a UTC machine this falls through),
   then the Royal Observatory Greenwich. Layers, display and quality are merged from defaults,
   prefs and the hash. `detectTier` picks the tier from the WebGL probe that `index.html` already
   ran, before the observer (which may wait up to 1.5 s for `cities.json`), and the tier's day and
   night maps start downloading at once (`prefetchTextures`, handed to the texture store later).
2. **Clock and first snapshot.** A hash `t` starts the clock paused at that moment. Otherwise it
   starts Live.
3. **UI.** It mounts immediately. The loop starts headless and publishes 4 Hz readouts, so the
   Sky Now table works before WebGL exists.
4. **Render stack.** It is imported in parallel (already downloaded: see 'Early downloads' below).
   The render context is created, then each module in its own `try/catch`. Textures start as 1×1
   placeholders, and a day or night slot shows its 512 px preview as soon as that is decoded.
5. **Data.** `data/sky.json`, `data/cities.json`, the previews (critical) and the day and night maps
   (primary) load in parallel; the texture store claims them as soon as it exists, so they decode
   while the modules are built, and what is in before the compile starts is uploaded at once. If
   the catalog arrives late, the sky module gets it through `setCatalog`. The UI, mounted before
   any of it, reaches the decoded catalogue through the late-bound `services.catalog()`
   (`baseCatalog()`, one promise per visit; in text mode it fetches sky.json on the first ask).
6. **Compile.** `rc.compile()` runs behind the loader, capped at 10 s: the scene (and the
   overlay) against the post chain's input target, then the chain's own pass materials (bloom,
   supersampling, the final pass) on a stand-in quad, with three's `compileAsync` where
   `KHR_parallel_shader_compile` exists and `renderer.compile` otherwise (the links then happen at
   the first frame).
   `textures.holdUploads` keeps eager uploads back until it settles and one frame is out: an
   upload issued while the GPU process links the shaders waits for that work on the main thread
   (≈ 360 ms measured on a desktop GPU), while one issued afterwards takes a few ms. A map decoded
   meanwhile is still bound; the frame that draws it uploads it. three's
   `debug.checkShaderErrors` stays on: turning it off only moved the same wait from
   `getProgramInfoLog` to `getProgramParameter` (5.4 s against 5.0–5.5 s under SwiftShader), and
   it is what reports a shader that fails on an exotic driver. The inline probe's context is not
   handed to three either: three asks for `alpha: false` and antialiasing by tier, which is only
   known in `main.js` (hash, prefs, learned tier).
7. **Render.** `loop.attach(...)` adds the renderer, after waiting up to 300 ms for the previews to
   decode (a downloaded preview is a few ms from ready, and a decode that resolved after the first
   frame would leave that frame without it). Store subscriptions start driving modules.
8. **Ready.** The loader fades once the previews are in (or, if they fail, the day and night maps),
   after 5 s, or when the user chooses "Slow connection — continue with low detail", and then only
   after the loop has drawn a frame (at most 4 s more): without `KHR_parallel_shader_compile`,
   `compile()` returns at once and the first frame is where the shaders link, so the loader leaves
   over a drawn globe. `status.phase` becomes `'ready'`. When the day or night map replaces a
   preview that was on screen, the Earth sharpens into it over 600 ms (`uSharpen`, instant with
   reduced motion); a map that arrives before the first frame is simply shown. While loading,
   texture progress moves only the loader's bar; a frame is requested when a map is in or failed.
9. **Intro.** It plays on the first visit unless the hash has `intro=0`, a `cam`, `view=sky` or
   `tour`, or the user prefers reduced motion. Otherwise the beams launch with a short stagger. It
   holds its opening pose for the loader's 0.7 s fade (pre-roll), and the horizon disc grows out
   with the pin's ripple. A `tour=` link starts its tour here (also in text mode). As the beams
   launch, the UI fades in a title card ("Ho Chi Minh City" over "21:00 · 6 worlds above you",
   `ui/intro-caption.js`, on `<body>` because `#ui-root` is hidden; announced, never under
   reduced motion). On a first visit from a plain link (`env.firstRun`: no `cam`, `tour`, view or
   `intro=0`, on the Earth's globe) the coach marks follow 1.5 s after the intro (`ui/coach.js`;
   under reduced motion, which skips the intro, 1.2 s after ready), once (pref `coachSeen`).
10. **Idle work.** Deferred textures (cloud and ocean masks, Moon, Milky Way), one almanac
    and events push from the worker, and the service worker (`app/sw-client.js`: on https hosts,
    or with `#sw=1` in the hash the page opened with). The worker is handed the URLs this visit
    already loaded, so the next visit works offline with this visit's textures too (§9 'The
    service worker').

Feature detection happens in `index.html` before any module loads. With no WebGL2 or no import
maps, the body gets `no-webgl`, the canvas is hidden, `fallback.js` shows the banner, and the panels
carry the app.

Night vision is applied before the first paint too: a classic script at the top of `<head>` reads
the saved `pc2.display` and, when `red` is on, puts `is-red` on `<html>` and turns
`meta[name=theme-color]` to `#000` (keeping the original in `data-base`). `main.js
bindNightVision` takes over once the store exists.

### Early downloads

A cold boot would otherwise find its ~165 modules one import level at a time (main.js →
render/context.js → postfx.js → EffectComposer.js → CopyShader.js is five round trips), and the
Earth maps would wait for all of them. Instead every byte of the boot starts within the first
round trips:

| What | Started by | When |
|---|---|---|
| main.js's and the UI's static module graphs (≈ 100 files) | static `<link rel=modulepreload>` in `<head>` | as the HTML is parsed |
| three.js and the render stack (≈ 65 files, `importRenderStack()`'s static graph) | the feature-detection script, only when WebGL2 and import maps work | right after the probe |
| `earth_day_preview.webp`, `earth_night_preview.webp` (12 + 6 KB) | the same script: `<link rel=preload as=fetch crossorigin fetchpriority=high>` | right after the probe |
| the tier's day and night maps | `main.js boot()` (`prefetchTextures`, same mode and credentials, so the previews' preloads are reused rather than fetched twice) | as soon as the tier is known |

Text mode downloads none of the 3D files (three.js included). Both module lists are generated by
`npm run preload` (`node scripts/lib/modgraph.mjs --write`): the core list is the static import
closure of `js/main.js` and `js/ui/index.js`, the 3D list that of every `import()` in
`importRenderStack()`, minus the core, three.js first. `test/repo.importmap.test.mjs` fails when
index.html's lists are stale, so a new render module or a new static import means one
`npm run preload`. Modules loaded on demand (tours, the recorder, Mars) and the astro worker's
graph (a worker has its own module map) are not preloaded.

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
| `is-coaching` | The coach marks are on screen (`ui/coach.js`). |
| `is-system` | The globe view is zoomed out into the solar system (`view.system`, the orrery past half its crossfade). |
| `is-red` (on `<html>`) | Night vision (`display.red`): the whole page dim pure red (§12). |

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
  `actions`), layers, display (with `red`, night vision) and the quality setting (written by
  `main.js` subscriptions). The UI
  keeps a few conveniences of its own in `core/prefs` (recent places, `skyDome` — the Charts card's
  `{open, mode, chart}`, with the older `tonightOpen` read once to migrate it —, `coachSeen`,
  `installHint`, `uiVersion`, and `displayOpen`, Display's open groups).
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
  which lands at 70° as before. A transit seen from here lands on its `visibleMs` at 2°, a star
  occultation on the Moon at 5°, and a meteor shower paused on its best hour here facing `ev.look`
  (the radiant; events without a body carry `look`), on the meteor composite.
- **Phase 6 sky content** (events-breadth, meteor showers, the year planner, Sun paths). The UI
  hub's `events` request carries `skyLp` (the site's artificial zenith light from `snap.skyglow`) so
  meteor rates read "under this sky"; a coarse change of it (the city estimate arriving, the Sky
  darkness setting) refreshes the list. The body card's planner asks the worker for
  `visibilityYear` (the observer, the first of the month at local standard midnight; cached per
  observer and month, debounced) and draws the event ticks from `ui.events`. `render/sunpath.js`
  asks for `sunFigures` through `main.js requestSunFigures` (today starts at the zone's midnight).
  `render/meteors.js` reads `clock` directly (sim time and rate) and calls `onAnchors` →
  `labelsFeed.markDirty()` when its radiants change; its labels reach the feed via `getSkyExtras`.
- **Tonight and the time bar's sky** (ROADMAP tonight-planner, sky-ribbon-scrubber). The UI hub's
  `night` request (`tonight`, once per night and observer) now carries `series`: the 10-min,
  solar-noon-to-noon altitudes the verdicts were drawn from (one packed `Float32Array` row per
  report, the Sun's unrefracted `sunAlt`, `t0Ms`, `stepMs`), so the charts cost no extra Astronomy
  Engine work. `ui/tonight.js` draws Up now's Tonight chart (one of the Charts card's two) from it:
  the window is sunset − 1 h … sunrise + 1 h (the whole 24 h under the midnight sun, with 'No darkness tonight',
  and in polar night); columns take the sky colour of the Sun's altitude; each body's ribbon has
  an alpha by altitude (a third by day) in its colour token, a dot at its `bestMs`, and a line at
  `clock.tMs`. The sky and ribbons are one `ImageData` (one pixel per CSS column, a row per lane),
  rebuilt only for new data, width or window; a redraw composites it and draws the marks, and only
  when the now line moved half a pixel. A drag sets `clock.setTime` (pausing a running clock and
  resuming it on release, `ui.scrubbing` meanwhile), a click jumps with a 400 ms tween. Up now's
  rows draw a 24-h sparkline from the same series (noon to noon, with a dot at the clock's time
  while it falls inside), and rows below the horizon count down to the
  rise ('rises in 3 h 36 min', `fmtRelative` of the `next` window's `nextRiseMs`). The time bar's
  strip uses the shared `ui/sky-palette.js` (also the chart's): day blues, a golden-hour amber from
  +6° down to −0.833°, rose to violet through civil twilight, indigo nautical, deep indigo
  astronomical, near-black night; every colour keeps the bar's #e8edf6 text at ≥ 4.5:1 (unit
  test; the hour labels sit below the track anyway). Up to ±3 d it also keeps a Moon and a
  selected-planet series (worker `altSeries`, refracted, three windows around the view like the
  Sun's, cached and slid as two extra rows of the gradient's `ImageData`): a 3-px band along the
  bottom where the Moon is up, brighter the fuller it is (Meeus 48.4, `moonLitApprox`), and one
  along the top in the selected planet's colour (none for the Sun or the Moon, which the strip
  already shows). Local solar eclipses (C1–C4) and lunar eclipses (umbral, else penumbral phase)
  get a gold bar under their ticks. None of it applies standing on Mars (the chart hides, the
  bands stay clear). Fling and haptics were proposed and not built.
- **The Sky dome** (ROADMAP sky-dome-chart, `ui/sky-dome.js`, the Charts card's other chart in Up
  now and, larger, the hero of text mode). An azimuthal-equidistant all-sky chart (r = zenith
  distance / 90°) on one DPR-sized 2D canvas: the dome tinted by the Sun's altitude
  (`sky-palette.js`, brighter on the Sun's side in twilight), altitude rings at 30° and 60°, the
  horizon ring with 16 ticks and N/E/S/W, the stars to mag 3.5 and the constellation figures from
  the catalogue, the J2000 ecliptic, the bodies above the horizon as colour-token dots sized by
  magnitude (refracted alt/az, as the rows show them), the Moon at its phase with the lit limb
  toward the Sun (`limbAngle`, measured along the great circle on the chart), the Sun with a glow,
  and labels placed greedily (`placeLabels`: right, left, above, below; never over a dot, another
  label or the compass letters). 'Looking up' puts east on the left, 'Mirrored' on the right
  (pref `skyDome.mode`: `up` | `map`). A tap selects the nearest body (else a named star to mag 2.5,
  `star:<hip>`) with `actions.select(id, {fly: true})`. In Sky view the read-only
  `actions.getView()` (the rig's CamView plus the scene canvas's aspect) gives the camera's field,
  drawn as the outline of its image rectangle (`fovOutline`). The stars arrive late-bound through
  `services.catalog()` (`main.js baseCatalog()`: one decode per visit, from the 3D boot's fetch of
  `data/sky.json` or, in text mode, fetched when the card first opens; shared with text mode's
  star selection; a failed load resolves null and is retried on the next ask). Text mode fetches
  the 175 KB file rather than an embedded bright-star list because every 3D tier already has the
  catalogue, so an embedded list would cost every tier's budget bytes that only text mode uses;
  sky.json also brings the figures and names. Redrawn on change, never per frame: the chart is
  built into an offscreen canvas from the 4 Hz readout at most once a second (with a trailing
  timer so a paused clock still gets its last state), at once for a selection, observer, size,
  orientation or catalogue change; stars, figures, names and the ecliptic are reprojected into
  preallocated `Float32Array`s only when the time, the observer or the orientation moved. The
  wedge is composited over that canvas when `getView()` changes, polled every 250 ms only while the
  dome is the chart shown and the view is Sky view. A rebuild costs about 1 ms. It works on Mars too (the Earth
  in slot 4, the Moon as a plain dot).
- **Event glyphs and 'Add to calendar'** (ROADMAP event-glyphs-and-ics). Each Events row and the
  Next-up card show `ui/event-glyphs.js`: a 24-unit inline SVG built from a pure spec
  (`glyphSpec(ev, {south})`, tested) and coloured by CSS tokens (`--body-*`, `--ev-copper`,
  `--ev-meteor`; `var()` goes into `style`, which presentation attributes do not accept). Moon
  phases are lit on the side this hemisphere sees; a pairing is both bodies' dots spaced by
  `sepDeg`; a local solar eclipse's `obscuration` and a lunar eclipse's umbral fraction become the
  discs' offset (`offsetForCover`, bisection on `astro/shadow.js discVisibleFraction`), cut as a
  lens (`lensPath`, an even-odd hole in the Sun, copper on the Moon); solstices draw the Sun's arc
  high in this hemisphere's summer. No canvas and no cache: a re-render clones a few paths. The
  calendar button on each row and the card, and 'Add all N eclipses of the next 12 months' (under
  the list, or leading it under the Eclipses filter; `eclipseBundle` drops a global solar eclipse
  seen here as a local one), go through `ui/ics.js`: `buildCalendar` writes a VCALENDAR with one
  VEVENT per event (UID = event id + place, so a later export updates rather than duplicates;
  DTSTART/DTEND in UTC from `eventSpan`: C1–C4, U1–U4 or P1–P4, a transit's or pass's span, a
  shower's best hour, else an instant; SUMMARY, DESCRIPTION with the detail, the place and the
  link; URL; a display VALARM 30 min before), escapes TEXT and folds lines at 75 UTF-8 octets.
  The link is `actions.shareUrl({event})`: the place, the instant a jump lands on
  (`eventFraming`), paused, the event's selection (none if it has none) and view, never Mars, no
  camera (the app turns to the selection), `intro=0`. `saveIcs` shares the file
  (`navigator.share({files})`) on a coarse pointer when `canShare` allows, since an iOS home-screen
  app opens no blob download, and otherwise downloads a Blob through `<a download>`; desktops
  always download. All offline, text mode included.
- **The place search's sky preview** (ROADMAP picker-place-preview, `ui/location.js`). Every
  offline city, online result, coordinate entry and recent place gets a pill under its name: the
  local clock at the simulated time (`ui.fmtClock(t, {tzName})`; a result without a zone takes the
  nearest city's within 300 km, as `normalizeObserver` would, else the longitude's `Etc/GMT±n`,
  shown as '≈ 05:12' with a tooltip saying so) and the Sun there
  ('sunrise in 12 min' within 90 minutes, else day, civil, nautical or astronomical twilight, or
  night) with ', Moon up', on the sky's colour at that Sun altitude (`sky-palette.js`). `placeSky`
  needs no astronomy call: a body's altitude is 90° minus the great-circle distance to its
  sub-point in the readout (`subLatDeg`/`subLonDeg`, geocentric: within 0.05° of AE for the Sun),
  the next crossing comes from the hour angle with the sub-solar point moving west at 15°/h (to a
  minute within the 90-minute window; tested against `SearchRiseSet`), and the Moon is up when its
  geocentric altitude exceeds Meeus' standard +0.125° (parallax, refraction, semi-diameter). The
  pills refresh at most once a second from the readout while the palette is open, and are absent
  standing on Mars (no Earth sub-points).
- **Sidereal tracking and the telescope** (`view.track`, url `trk=b|s`, K). In sky view the rig
  can keep the selected body centred at its refracted place (`'body'`, zenith up) or hold the
  star field still with the J2000 pole up while the horizon swings (`'stars'`); engaging and
  releasing blend the orientation over 600 ms, a drag moves the tracked aim, and below −8° the
  rig ends it and `main.js` toasts. `actions.telescope(id)` frames a body at `telescopeFov` (Jupiter
  with its moons, the Moon whole, else the 0.2° `SKY_FOV_MIN`) with tracking on; the zoom eases in
  log space. It records `ui.scope = {id, fovDeg, prevFovDeg, prevTrack}` (never in the URL): the
  telescope's mode chip and its way out, `actions.leaveTelescope()` (the field and the following it
  found, 60° from the globe; the selection stays). The scope ends with another selection, a view
  other than Sky, Follow set free, or a field zoomed out past max(10°, 3 × fovDeg) once the zoom-in
  has arrived (on the 4 Hz readout, through `rig.getView()`, no layout read). A link with
  `view=sky`, a selection and a sky `cam` of 5° or less gets one too (`scopeFromLink`, `main.js`). Below `FINE_FOV_DEG` (2°) the loop recomputes the frame snapshot on every frame that
  sim time moved and keeps drawing while the clock runs. Planets cross-fade from glyphs to the
  shared impostor at true size (`astro/disc.js scopeBlend`, `render/planets.js` telescope mesh),
  Jupiter's moons become discs below 6°, and the star limit gains up to 3.5 mag (`scopeGainMag`).
- **Modes, menus and Esc** (docs/roadmap/UI-REDESIGN.md §4.2–4.4, §5.1). `ui/modes.js` keeps one
  status stack after the top bar (`role=region` 'Active modes'): each mode's owner sets a chip with
  `ui.modes.set(id, {icon, title, detail, actions, exit, guard})` and clears it when the mode ends
  (`view`, `map`, `scope`, `follow` in `view-switch.js`; `ruler`, `aim` in `sky-tools.js`;
  `expose`; `pick` in `shell.js`; `loop`, a `clock.range` that is not the analemma's stride, in
  `modes.js`: 'Looping {from} → {to}', or 'Playing {from} → {to}' with Stop for a one-shot range
  such as Play the eclipse). Under the top bar the stack sits below the Eclipse Companion, or
  beside it on a window 1240 px or wider (css `--sx`/`--sy` from the HUD's `--ecl-w`/`--ecl-h`). Chips keep activation order, the flash (`ui.flash`, an alias of `ui.modes.flash`) is
  always the last child, and the newest chip's exit carries `Esc`. `shortcuts.js` Esc runs: Search,
  Help, a text field, the hidden interface, `ui.modes.exitTop()` (the newest chip's exit, flashing
  its `done` text), then the selection; menus, dialogs, tours and the phone sheet at full take it
  first. `dom.js menu({button, label, items, placement})` builds Tools, Share and ⋯: rebuilt from
  `items` on each open (no store subscriptions), `menuitem`/`menuitemradio`/`menuitemcheckbox` in
  titled groups, ● and ✓ for checked rows, a kbd column on fine pointers, arrow-key roving
  (`rovingKeys`, shared with `segmented`), Esc back to the button, Tab onward (`openPopover` closes
  any popover, the Time popover too, when focus moves out of it and its button). Tools' contents follow
  the view (its accessible name too: 'Tools for the globe / map / Sky view'), and its 6-px dot
  marks any tool in use. Labels (`render/labels.js`) treat the chips and the Eclipse Companion as
  occluders.
- **The time bar and the Time popover** (docs/roadmap/UI-REDESIGN.md §4.5, `ui/timebar.js`). The bar
  holds only transport, the date button, the accuracy badge, the speed and Live / 'Return to now';
  nothing in it is hidden by width (a narrow bar drops the step buttons' unit text, the zone's place
  and the Return-to-now words, and under 800 px wraps to two rows). The step buttons show their unit
  (`STEP_UNITS`: '1 h', '1 sid. day'…) with a two-line tooltip (`data-tip` with the key, then
  `data-tip2`: the Shift and Alt steps). The date button's `.stamp__zone` shows the clock's zone from
  `zoneTemplates(mode, approx)`, whole-phrase templates filled by `tpl()`: '{place}, {offset}', 'This
  device, {offset}' or 'UTC', and the short '{offset}' under a 940-px bar. The place gives way first:
  `fitZone` cuts it to the room it has and adds the ellipsis itself, because CSS's `text-overflow`
  leaves up to a glyph's gap before the comma; with room for fewer than six letters the short form
  shows. It refits when its text changes, when the date button's size changes (a ResizeObserver,
  acting in a task after its callback: LIVE or Now, the layout, the window) and on leaving Mars. On the phone the stamp is three lines (time and chevron, the day, then the long zone),
  since no phone width has room for the day and the zone side by side. The speed readout is
  muted with 'Speed: {rate}, paused' as its name while paused, reads 'Loop' while a clock range
  runs ('Playing' for a one-shot range), and Slower's tooltip at 1× warns that it turns time around. The date button, and the loop
  chip's Edit through `ui.openTime(section)` ('go' | 'step' | 'loop' | 'zone'), open one non-modal
  `role=dialog` popover (`#pop-time`, `openPopover`, focus on the section's first control, Esc back
  to the date button): Go to (the zone-labelled input, quick jumps, the Julian entry, the accuracy
  sentence while the badge shows), Stepping (the unit select, the Shift/Alt hint on fine pointers,
  Time runs Forward | Backward kept in sync with R through `clock.onChange`, and on the phone the
  step buttons themselves, which `arrange()` moves there), a Loop `<details>` (open while a range
  runs; From, To, one loop's length, Playback Loop | Back and forth | Once), Show times in
  (`actions.setTzMode`, announcing 'Times in {zone}.', and the 24-hour switch, `display.hour12`)
  and a legend of the scrubber.
- **Panels, the phone's tab bar and Display** (docs/roadmap/UI-REDESIGN.md §3, §4.6, §4.9–4.11).
  `shell.js TABS` are the five tabs of `store.PANELS`: Up now (`sky`), Details, Events, Explore and
  Display; each pane opens with a visually hidden `h2`. The old ids still open from links
  (`PANEL_ALIASES`: `layers` → Display, `settings` → Display revealing `conditions`, `about` → Display
  revealing `about`). `ui.openPanel(id, {focus, sheet, reveal})` (also on `mountUI`'s return, for
  `main.js` at boot and on `hashchange`) shows a tab; `reveal` names a `[data-reveal]` section, which
  is opened (the `<details>` it is or is in), scrolled to, its `[data-autofocus]` control (Light
  pollution), else its summary or first control, focused and `.is-flash`ed for 1.2 s. The desktop rail (64 px) shows each tab's icon over its label. On the phone the same
  tablist node moves into `nav.navbar`, a solid bar of five 56-px tabs under the sheet (`--nav-h`);
  the sheet sits on it and its head is the handle and the time bar only. `measureSheet` works above
  the tab bar: peek is the head, half `clamp((vh − nav) / 2, head + 192, full)` (at least 190 px of content), full
  all but 56 px.
  A tab tapped (or arrowed) at peek raises the sheet to half; a world picked in the view (its label,
  the orrery, a sky object, the map: `main.js showPicked`) opens Details and, at peek, raises it
  too, so its name shows; a Jump, a moment or a tour does not. Above peek the floating column keeps
  only the view segment, and none at full; the focus trap at full covers the sheet and the tab bar
  (`trapFocus` takes several roots). Tablets in portrait (≥ 600 px) get a 560-px sheet and tab bar
  on the left, the globe beside them. Display's layers (`LAYER_GROUPS`, each with `where`: 'globe'
  (the map and the solar system count as the globe), 'sky' or 'both', checked against the render
  modules) list the current view's first (`layersFor(view)`, pure) and the other view's in an 'Only in
  Sky view' / 'Only on the globe' group; Reset layers writes `DEFAULT_STATE.layers` once. Every
  group in Display (Beams and labels, Stars, Guides, Earth, In orbit, the other view's, then Quality,
  Sky conditions, Comfort, About this app) is a `<details data-reveal="{id}">` whose summary is its
  title and its live state on the right ('6 of 6 on', 'Auto (running Low)', 'Bortle 9 · Typical
  aurora', 'Night vision off', 'Version 2.0.0'), so the tab reads as a table of contents (1.0
  screen at 1440×900 in both views). A first visit opens Beams and labels; after that pref
  `displayOpen` (the open ids, any toggle or reveal) restores what was left open.
  The help table's Layers rows and the shortcut flashes take their names from `LAYER_GROUPS`, and
  `actions.LAYER_LABELS` repeats them (`test/ui.layers.test.mjs`). Returning visitors (`introSeen`,
  pref `uiVersion` below 2) get one toast saying where Settings, tours and history went
  (`coach.js`).
- **Up now, Details and the sky search** (docs/roadmap/UI-REDESIGN.md §4.1, §4.7, §4.8).
  - Up now opens with three whole-phrase lines (`sky-now.js updateSummary`): a Day / Twilight /
    Night / Solar eclipse badge with "Fully dark {dusk}–{dawn}", sunset and sunrise with the Moon,
    and the light pollution (`skyDarknessText`: "{class}: stars to magnitude {m} (Bortle {n})" once
    the Sun is 15° down, the class from `layers.js BORTLE_NAMES`) with a Change link to Display's
    `conditions`. Its ⓘ (`aria-expanded`, focus moves into the text) holds the Sun's altitude and
    the terms as sentences, and the aurora line. Then the list, then one Charts card: a header
    button and a Sky dome | Tonight segment over the two charts' bodies. Only the chart shown is
    drawn or polled (`setShown`). The card is open by default on a desktop at least 800 px tall
    and in text mode; once toggled, `skyDome.open` decides. `chartsPref` (pure, tested) reads the
    stored `skyDome` and migrates `tonightOpen`.
  - Details (`body-card.js`) puts the verdict and the action row first: Look at it (sky view and a
    flight, or `select` + Sky view), Telescope (`aria-pressed` while `ui.scope` is this body; a
    second press is `leaveTelescope`), Follow (Sky view) and a `menu()` More (Turn the globe toward
    it, View the Earth from {name}, Earthrise, Compare from a second place…; items hide by view,
    host and kind, and the button with them when nothing is left). Text mode shows Compare alone,
    as a button. Path ±6 months, Where it's up on Earth and Sun paths are `switchRow`s that write
    the same layers as Display (labels from `LAYER_GROUPS`). The fact grid keeps the everyday
    facts; More positions and What these numbers mean are closed `<details>` (no `title=` hints),
    The year ahead too, its sentence in the summary and its chart drawn only while open.
  - The place search's In the sky section (`location.js`) indexes the host's nine bodies, the
    extras registry (not its stars) and `services.catalog()`'s named stars on first use, and
    drops the index when the registry changes or the host moves. `rankSky` (pure, tested) ranks
    a prefix, then a word's prefix, then a substring (diacritics folded, `also` for designations
    like M31), the nine first at each level, six at most. A row says where it is now from the
    readout (a star's `dirS` against the observer's ENU). Choosing one selects it with a flight,
    closes the palette and opens Details (`sheet: 'half'`).
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
  The track names each contact in plain words (Begins, Totality, Peak, Totality ends, Ends;
  Partial begins … for the Moon) with its code beneath, and a hidden whole phrase ("Totality
  begins (C2) at 13:01:55") for screen readers; the jump reads "Jump to just before totality"
  (or annularity, or "Jump to the peak"). On a phone it folds to its countdown while the sheet is
  above peek or the view is Sky; the user's own toggle holds until the eclipse ends.
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
  layers and selection are untouched. `actions.exposeStatus()` feeds the `expose` chip; the
  first Esc with frames stacked only warns (the chip's `guard`), a second within 3 s stops.
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
- **Vantage points** (`view.vantage`: `'none' | 'l1' | 'moon'`, url `vt=l1|moon`; Tools › Look from
  on the globe, 'Earthrise' on the Moon's card). `actions.setVantage(kind)` sets the globe view
  with it; 'Globe', 'Sky', the `view` chip and Esc clear it. `main.js` hands it to `rig.setVantage`, which loads
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
    `main.js` writes to `ui.ruler` (the `ruler` chip, `ui/sky-tools.js`) and turns into a label rebuild
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
- **The flat map** (`view.mode = 'map'`, url `view=map` with `cam=m:lat,lon,dist`; M, the Map
  segment of the toolbar; its `map` chip, Esc or 'Globe' returns). The rig orients a plane (`geo/mapview.js`: north up,
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
  sightlines imply (`astro/parallax.js`, re-read every 0.5 s). Up now shows the selected body (else
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
  'Solar system · distances to scale · planets enlarged' chip with 'Back to the globe' (Esc too). Any
  other camera move (a fly-to, sky view, the flat map, a vantage, the chase, `frameSpan`) first
  zooms back to 150 R (1.8 s), then runs, so the map's morph and the system zoom never overlap
  (`systemBlend` is 0 while `mapK` > 0, and `labelMode` checks the map first); 'Solar system' from
  the map rolls the globe back up before it flies out. The overlay coexists with the frame's other
  passes: it is drawn before the stacking or supersampling pass, an idle supersampling sample
  jitters the orrery camera with the globe camera's (`rc.render(ss)`), and `loop.step()` (the video
  recorder) sets `FrameInfo.systemBlend`, so a time-lapse shows the orrery too. The second place's
  beams fade with the first set's. Orbits come once from the worker (`orbits`); a selected planet
  gets the retrograde figure (ASTRONOMY.md §4). Low tier: lines and sprites only (no disc-shader
  Sun). Text mode: n/a (Tools is not shown).
- **`bus`** carries transient events. `readout` is the full-detail snapshot at 4 Hz, published
  only when time or the observer changed. The UI requests its own almanac data through
  `services.astro`. `main.js` pushes one almanac and events set at boot as a head start.
- **Snapshots.** `snap` is frame detail. It is recomputed when sim time moves by 0.5 s or more, the
  observer changes or the clock jumps. `snapFull` is full detail at 4 Hz. Both are preallocated
  once and rewritten in place. `__app.snapshot()` returns `snapFull`.

### Extra objects: selections beyond the nine bodies

The nine `BODIES` stay a contract (their order, `Snapshot.bodies`, the beam instances, the 1–9 keys,
`BODY_IDS`). Everything else that can be selected, labelled, picked and shown in the body card is
an **extra object** with a namespaced id (`core/selection.js`): `<kind>:<key>`, kind one of
`star`, `dso`, `comet`, `craft`, `guest`, `sat`, key `[a-z0-9][a-z0-9._+-]{0,31}` (e.g. `comet:halley`,
`craft:voyager1`, `guest:sn1054`, `star:27989`, `dso:m31`, `sat:iss`).

- **State and URL.** `store.selection` is a BodyId, an extra id or null (`isSelectionId`).
  `actions.select(id)` accepts both; `sel=` round-trips both (`normalizeSelectionId`; a well-formed
  extra id is kept even while its data is loading). `trk=b` tracks an extra too (the rig finds it
  in `snap.extras`).
- **Registry** (`astro/extras.js`, `createExtras()`; one per app: `R.extras`, `__app.extras`). A
  module registers a **provider** per kind: `extras.register({kind, kindLabel, ids(), meta(id),
  fill(snap, id, st), card?(id, st, snap)})` → an unregister function. `meta(id)` returns
  `{name, color, glyph:'star'|'marker'|'coma'|'none'|'sat', label:'always'|'selected'|'never', layer?,
  short?}`: `glyph` says who draws it ('star' and 'marker' by `render/extras.js`, 'coma' and 'sat' by
  their own modules, 'none' by an existing layer, e.g. a catalogue star: only the selection ring), `layer` a
  `Layers` key that must be on. `registry.refresh()` re-reads a provider's `ids()`; `onChange(fn)`
  fires on every registration change (the loop recomputes both snapshots, the labels feed rebuilds,
  the body card completes). `registry.provider(kind)` returns a provider for its own API (the
  satellites' `elements()`, `sat(id)`, `validDays`).
- **Per snapshot.** The loop calls `extras.fill(snap)` right after `computeSnapshot` (frame and
  full detail; with the skyglow and aurora fills). It keeps `snap.extras`, an array of
  **ExtraState** in registry order (`snap.extrasVersion` = `extras.version`), created once per id
  and refilled in place: `{id, kind, dirS (Float64Array(3), topocentric astrometric J2000, scene
  frame — like BodyState.dirS), distAU (NaN at infinity), lightTimeS, mag (NaN: none), altGeomDeg,
  azGeomDeg, altDeg, azDeg (refracted), above, present, approx, data}`. The provider's `fill` sets
  `dirS`, `distAU`, `mag`, `present` (exists and is drawn at this instant), `approx` (outside its
  data's validity) and its own preallocated `data` (Halley's tail samples, a craft's geocentric
  vector); the registry adds alt/az from the snapshot's observer frame. Helpers:
  `topocentricScene(gx, gy, gz, snap, out)` (geocentric AU → topocentric unit vector, distance),
  `extraSky(st)` (J2000 RA/Dec and constellation, for cards). `registry.state(snap, id)` finds one.
- **Per frame: fast movers.** A provider may also implement `advance(snap, id, st, tMs)`. The loop
  calls `extras.advance(snap, t)` on every rendered frame whose sim time differs from the
  snapshot's (before the rig, so tracking follows), and the registry refills those states (and
  their alt/az) for the frame's own instant; everything else keeps its snapshot state. Satellites
  use it: the ISS crosses a sky view at ~1°/s, which 0.5 s snapshots would draw as 0.5° jumps
  (SGP4 costs ~0.3 µs; six satellites ~5 µs a frame). `FrameInfo.tMs` carries that instant.
- **Consumers, generically.** Labels (`labels-feed.js`): an anchor per labelled extra at its live
  `dirS` (orbit view: a spacecraft's label rides its beam, a satellite's sits on its dot, `data.posS`;
  sky view: a satellite is named only while bright enough to see, its magnitude gating it like a
  star name), `gate` = present, `below` per frame,
  priority 78 (100 when selected; meta `priority` overrides), `skyOnly` (sky view only unless
  selected), `nightMag` (gated by the drawn sky like a star name). Picking (`main.js`): after the
  bodies, `R.mods.satellites.pickCandidates(skyView, camera)` (sky view: lifted directions; globe:
  the dots the camera can see, `picking.pickPoint`), then `R.mods.extras.pickCandidates()` (drawn,
  refraction-lifted directions, 16 px); then, on
  the sphere at the tap's true direction (`picking.skyTapDir`: the drawn refraction taken off),
  `R.mods.dso.pick` (inside a visible object's outline) and `R.mods.sky.pickStar` (the drawn
  stars within 14 px, nudged toward the brighter). Body card (`ui/body-card.js`): the provider's
  `card()` → `{kindLabel, subtitle, lines[], facts[[label, value]], caveat, sources[], rts?}` plus
  the generic position sentence (the one place the constellation is named), 'Find it', alt/az,
  magnitude, J2000 sky coordinates; actions Look at it, Telescope (`telescopeFov`: the provider's `data.fovDeg` when it sets one — a deep-sky
  object's whole outline, 3° around a star — else 24° for a comet, 6° otherwise) and, in Sky view, Follow. The UI hub's
  `bodyName`/`bodyOf` answer for extras (`ctx.extras`), so the narrator and Sky panel work too.
  Render modules get `setSelection(id)` as before; the nine-body modules ignore extra ids.
- **Providers today.** `guest` (`astro/guest-stars.js`, 'stars' layer), `comet` (`astro/comets.js`),
  `craft` (`astro/craft.js`, the `spacecraft` layer, off by default; registered when
  `data/craft.json` has loaded), `dso` (`astro/dso.js`, the `deepSky` layer, on by default;
  140 ids, registered when `data/dso.json` has loaded; drawn by `render/dso.js`), `sat`
  (`astro/satellites.js`, the `satellites` layer, on by default; six ids, registered when
  `data/tle.json` has loaded, the module imported only then; see Satellites below) and `star`
  (`astro/stars.js`, 'stars' layer; registered once `sky.json` is decoded). The star provider
  lists **one** id, the selected star's: `R.starExtras.sync(selection)` (a store subscription, and
  `pickSkyObject` before the selection lands) calls `track(id)` and `extras.refresh()`, so
  5,000 (or 41,000) stars never cost a slot each. Its card reads `data/starinfo.json`, fetched the
  first time a star is selected (a refresh then renames 'HIP n' to its designation). A later kind
  adds a provider in `app/extras-setup.js` (or registers when its lazy data arrives) and, if it
  draws its own glyphs, a render module that reads `snap.extras`.
- **The star field's epoch (time-machine sky).** `render/sky.js` owns the installed catalogue's
  epoch: on each snapshot whose whole year from J2000 differs it calls
  `catalog.applyProperMotion(catalog, years)` (the 1,183 fast movers' directions, the constellation
  endpoints snapped to them and the star-name label vectors, in place) and copies the moved stars
  into its drawn arrays. Labels, the star provider and picking read the same arrays, so they agree.
- **The max tier's deeper stars.** `main.js syncDeepStars(cfg)`: on a tier with `deepStars`
  (max) it fetches `data/stars8.json` once, `mergeDeepStars` it after the base stars (same
  indices) and installs the merged catalogue (`R.catalog`, `sky.setCatalog`); any other tier puts
  `R.baseCatalog` back. The star shader's aperture gain also brightens faint stars (up to a
  mag-2.5 look), so the telescope reveals them.
- **Readout after a registry change.** The loop keeps a `fullStale` flag: a registry change (or a
  new observer) inside the 4 Hz interval still recomputes the full snapshot, even paused.

### Satellites: the ISS, Tiangong, Hubble and bright rocket bodies

- **Data.** `data/tle.json` (≈ 2 KB): two-line element sets for the six objects in `SAT_INFO`
  (`astro/satellites.js`: NORAD numbers, names, colours, standard magnitudes), written by
  `scripts/fetch-tle.mjs` from CelesTrak. The page never contacts CelesTrak (R4). The committed
  file is refreshed by hand; the Pages deploy (`.github/workflows/pages.yml`, now also on a daily
  `schedule`, which first checks that CI passed on that commit) writes a fresh copy into the
  **staged** site only — nothing is committed daily. The script validates every set (checksums,
  catalogue number, SGP4 accepts it, < 30 days old) and keeps the previous one for any that fails;
  a CelesTrak outage leaves the committed file (the step is `continue-on-error`). It is outside
  the service worker's version (`sw-manifest.json`'s `fresh`, `stage-site.mjs FRESH_FILES`): `sw.js`
  serves it **network-first** (3 s, then the cache) instead of cache-first, so a returning visitor
  gets the day's elements while the daily redeploy, which changes nothing else, is no new version;
  it is precached too. No test depends on the date, so CI stays green however old the committed
  file gets.
- **Propagation** (`astro/sgp4.js`, pure): near-Earth SGP4 (Vallado et al. 2006, WGS-72), TEME →
  Earth-fixed by GMST (`temeToEf`); deep-space orbits (≥ 225 min) are rejected. Verified against
  Vallado's published vectors (`test/fixtures/sgp4-vallado.json`: 158 rows, within 1 mm).
- **Provider** (kind 'sat', glyph 'sat', layer `satellites`): `fill`/`advance` place the satellite
  Earth-fixed (km) against the WGS-84 observer, then in the scene through the snapshot's
  `earthMatrix` (`data.posS`: Earth radii, on the drawn globe; `dirS`: topocentric), with the
  sunlit fraction, magnitude, sub-point and speed in `data.look`. **Staleness:** `present` only
  within `TLE_VALID_DAYS` (14) of the elements' epoch, `approx` after 3 days; the card states the
  age and the window. `card()` adds height, speed, period, sunlit or in the shadow, the sub-point,
  and the elements' date and age.
- **Render** (`render/satellites.js`, in `space`): globe dots (depth-tested, grey in the shadow),
  short beams from the pin to those above the horizon (the beam shaders, no pulses), and the
  featured satellite's ground track ±1 orbit (the selected one, else the ISS; one 241-point line in
  an Earth-frame group, re-centred every 6 sim-minutes, brighter ahead than behind); in sky view
  star-material points at their magnitude (nothing in the shadow) and a ring for the selection.
  `update(fi)` refills the buffers from the advanced states. `moving(skyBlend)` (sky view, a
  satellite up and bright enough to see, or the selected one) is the loop's `liveMotion`
  (`attach`): while the clock runs it keeps frames coming, so at 1× the ISS glides. Vantage points
  hide the layer (`VANTAGE_LAYERS_OFF`).
- **Passes.** The worker op `satPasses {tle, observer, fromMs, days}` (`allPasses`: 60 s steps for
  rise and set, 5 s inside a pass, bisection to 0.5 s, a golden-section peak) returns the visible
  passes (≥ 10° up, at least half the Sun's disc on it, the Sun ≤ −6°, ≥ 60 s long) with start,
  peak and end alt/az, the brightest magnitude and how each begins and ends (rises or sets, out of
  or into the shadow, twilight). The UI hub keeps `ui.passes` for the next 10 days of sim time
  (`checkAlmanac`, emits `'passes'`; input `actions.satelliteElements()`). The Events tab merges
  them (bright ones under 'All', every one under 'Satellites'); the satellite's card lists its next
  six (`ui/sat-passes.js`) with a countdown to sim time and **Watch this pass**
  (`actions.watchPass`: the clock cut — not swept, so tracking never loses it below the horizon —
  to 30 s before it appears, playing at 1×, the satellite selected and, in sky view, tracked).
### Standing on Mars (phase 1: the sky view)

- **State.** `store.host` `{id:'earth'|'mars', latDeg, lonDeg, name}`: the world the observer stands
  on and the Martian site (planetocentric °N/°E, Jezero Crater by default; kept on Earth, so 'Stand on
  Mars' returns to it). URL `host=mars` (+ `hloc=lat,lon` off Jezero; §10). `actions.standOnMars(site?)`
  sets it with `view.mode 'sky'`; `actions.leaveMars()` clears it. `main.js bindHost` returns to the
  Earth whenever the view leaves the sky (the globe and the map stay the Earth's in phase 1) or an
  Earth place is chosen (any observer change not from boot).
- **Snapshots.** The loop's `setHost({compute})` replaces `computeSnapshot` for both the frame and the
  full snapshot with `astro/host-mars.js computeMarsSnapshot(t, store.host, out, opt)`: the same
  Snapshot, with `snap.host = 'mars'` and `snap.mars` (clock, site, moons, light time). The second
  place, the light-pollution site and the aurora are skipped on Mars. Everything else (tools that
  compute their own snapshots: tours, recorder, expose, aim) stays the Earth's.
- **The BODIES contract.** It is kept: slot 4 (`id 'mars'`, key 5) holds the Earth in a Mars
  snapshot (`astro/bodies.js EARTH_TARGET`, `hostBodies(host)`), so beam and glyph instances, the 1–9
  keys and `sel=mars` stay valid. Names and colours come from `hostBodies(snap.host)` (labels feed,
  edge chips, Up now, the card, the UI hub's `bodyName`); CSS turns `--body-mars`
  blue under `body.is-mars`.
- **The scene.** The camera stays on the unit sphere where the Martian zenith points
  (`observer.posS = upS`): the hidden globe lies under the ground. Earth-only modules are created
  inside `earthOnly` groups (globe, atmosphere, aurora, meteors, trails, Sun paths, eclipse ribbon,
  beams, pins, comets, spacecraft) that `app/mars-host.js` hides. Render modules with a
  `setHost(id)`: `ground` (Mars palette `#define MARS`, no Preetham dome, a barren landscape),
  `bodies` (the Earth's blue glyph in slot 4, the Moon as an extra glyph instance, dust extinction, a
  bluish solar glow), `edge-chips` (names). `render/mars-sky.js` adds the dome, Phobos and Deimos
  (opaque-depth discs, so a transit bites the Sun) and the home beam.
- **Extras.** Providers may name a `host` ('earth' for comets and spacecraft, whose parallax is the
  Earth's; 'mars' for `moon:phobos` and `moon:deimos`); the registry marks them not present in a
  snapshot of the other world. Glyph `'disc'`: drawn by its own module, picked like a glyph.
- **Degrading the Earth's features.** The UI hub's `riseSetFor` and `tonightFor` return nothing on
  Mars (the almanac worker is the Earth observer's), the card hides the sub-point, footprint, compare,
  Earthrise, paths, the year planner and the Earth's eyepiece portrait, the Events tab says its times
  are for the place on Earth, and the date button's zone gives way to the Mars stamp
  'Sol N · hh:mm LMST' (its name says Earth time and the sol) while the scrubber strip shows the
  Martian site's day and night.

### History: the Julian calendar, Moments and 'born under'

- Calendar dates before 15 Oct 1582 are shown Julian everywhere dates are printed: `format.fmtDate`
  and the UI hub's `zoned()` (which returns `cal`), the time bar's stamp (a 'Julian' tag whose title
  gives the Gregorian date), its day and month ticks, and the Time popover's Go to, which reads typed dates on
  or before 4 Oct 1582 as Julian (`tz.parseCalendarInput`; a Julian date the native picker cannot
  hold makes it a text field). Instants, the clock and `t=` stay Gregorian UTC.
- The Explore tab holds 'The sky you were born under' (a date and time in the time-bar zone →
  sky view at that instant and `skyCaption` of the next readout), the Moments and the Famous comets
  (`core/moments.js`: links whose `href` is the hash; the app applies it like any link and the
  phone sheet drops to its peek; the first four and three, then 'Show all').

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
  extras.advance(snap, t) if t ≠ snap.tMs          // fast movers (satellites) at this frame's instant
  moving = rig.update(dt, snap)
  motion = moving || rig.tweening || clock.isAnimating() || introPlaying || pointer held
           || (clock running && liveMotion(skyBlend))  // attach's liveMotion: a satellite up in sky view
  twinkleDue = twinkle tier && sky view && stars visible && ≥ 29 ms since the last frame   // ~30 Hz
  held = governor.probe()                        // before a step with no fresh cadence: frames off to measure it
  ssIdle = supersampling tier && !motion && !dirty && !twinkleDue && history below the cap
  if !held && ssIdle:
      rc.render({jitter, weight})                // an extra sample only: no updates, labels or governor
  else if !held && (dirty || motion || twinkleDue):
      dirty = false                              // cleared first: invalidate() during update requests the next frame
      module.update(fi) for every module         // fi: dt, time, tMs, camera, viewMode, skyBlend, snap, pulses, simRate, exposure, mapK, map, systemBlend
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
- **Paused drawing.** `loop.setRenderPaused(paused, reason)` stops the drawing but not the clock or
  the readouts. The reasons add up: `'context'` (the default: context loss, text mode) and `'tier'`
  (a staged tier switch). Drawing resumes once none is left, so a switch that ends during a context
  loss waits for the restore. `redraw()` draws nothing while paused.
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
4. Run `npm run preload`, so index.html preloads the new module with the rest of the render stack
   (the repo tests fail until it does).

It then receives layers, selection, tier and view changes, and its failures are contained.
A module may draw nothing at all: `long-exposure.js` has an empty group and is a module only for
`update(fi)`, which runs right before `rc.render()` on every rendered frame (it is created after
the rig, which it reads).

**What simulated time shows and hides goes through the material, not `visible`.** three uploads a
geometry the first time it projects the object, and `visible = false` keeps an object out of
projection. A part hidden until time brings it (a satellite rising, the first dusk, a comet's
apparition, a shower's radiant, Baily's beads, the Sun over the Earth's limb) would upload its buffers in the
middle of a run, which the smoke test's 'memory stable' check sees as a new geometry. Such parts
keep `visible` and set `material.visible` (out of the render list but still projected, so the first
frame uploads them) or draw zero instances (`instanceCount = 0`: three issues no draw call), and
mark their attributes for upload only while something is drawn. `visible` stays for what a user's
choice hides (layers, views, vantage points). A material shared with another module cannot hide
this way, so the guest stars and the satellites in sky view draw with a copy of the star material
on the same uniform objects (one program). `test/render.first-use.test.mjs` covers the modules that
do this: the star field and the Milky Way, the deep-sky sprites, satellites, extras, comets,
meteors, totality's beads and the flare.

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
  side panel / bottom sheet, and in Sky view with the Eclipse Companion (a top inset, so the eclipsed
  Sun is framed below it; `main.js bindViewInsets`). Beam anchors stay inside that free area (a beam that leaves the
  screen is labelled where it exits), and are de-overlapped in priority order by sliding along
  their own beam.
- **Labels never sit under UI chrome or off-screen.** `labels.js` treats the rects of
  `.ui .topbar > *, .ui .viewbar > *, .ui .timebar, .ui .panel, .ui .sheet` (`OCCLUDER_SELECTOR`)
  as occluders, re-read on resize and at most every 500 ms while rendering — never per frame. A
  label overflowing the viewport by ≤ 12 px is nudged inside, otherwise hidden. If you rename
  those UI classes, update `OCCLUDER_SELECTOR`.
- **No layout reads inside a frame.** A frame only asks for the occluder rects and new labels'
  boxes; a task queued from it (`readAfterFrame`, after the browser's own layout for that frame)
  reads them, and the next declutter uses them. A label never shown yet waits for its box,
  hidden but laid out, and that task places it at once; a shown label whose text changed keeps
  its old box until then. The time bar sizes its canvas from its ResizeObserver's entries and `bindViewInsets`
  (`main.js`) measures in a task after the frame, so a time-lapse calls `getBoundingClientRect`
  from no frame callback at all (a CI gate, §11).
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
- **Max.** "No budget": Display → Quality → Max, `#q=max`, or a saved choice. It is always pinned,
  so the governor never touches it. Its 8192 px Earth maps and 4096 px Moon load only on Max, after
  the 4096 (and 1024 Moon) maps of the same imagery (`INTERIM` in `textures.js`), which show
  meanwhile; so Max is ready as fast as High and sharpens in place. A GPU that cannot take a knob
  loses that knob only (`tierConfig`): under 8192 px it keeps the 4k Earth maps, under 4096 the
  4k-only features, and postfx clamps MSAA to the context. The service worker never precaches them;
  they are cached on first use (checked against the version's hashes), so Max works offline after
  one visit, and an update carries them over while their bytes are unchanged.
- **Switching.** Display's Quality and `?q=` pin a tier. Auto lets the governor step down, never up. If the
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
- **Applying a tier.** `applyTierCfg` hands the TierCfg to the tier switch (`app/tier-switch.js`,
  wired by `main.js makeTierSwitch`). The scene graph is never rebuilt. A tier with the current
  shader variants (a governor DPR step: the same tier name) applies at once, as before. Any other
  tier is staged, so its first frame compiles and uploads nothing (`hitch-free-tier-switch`):
  1. **Pause.** `loop.setRenderPaused(true, 'tier')`. The clock, the readouts and the panels go on.
  2. **Stage.** `rc.prepareTier(cfg)` builds the post chain (composer on or off, MSAA target,
     bloom, final pass, supersampling) at the current size, with no canvas resize, so nothing is
     presented. Each module's `setQuality` sets its defines and meshes, and the tier's maps start
     loading.
  3. **Compile.** `rc.compile({paced: true})` compiles every scene material against the next
     chain's input target (the canvas on the direct path), and every pass material against its
     own target. With `KHR_parallel_shader_compile`, `compileAsync` does this off the main thread.
     Without it, `paced` issues one new program per task, waits on a fence for the GPU process to
     catch up with the frames and uploads queued before it (a fence's status changes only between
     tasks, so polling it never blocks), and then links it. The main thread waits for one link at
     a time instead of the whole batch in the first frame. Either way three's first use of each
     new program (link status, info logs, uniform tables: `WebGLProgram.getUniforms`) runs now,
     not in the first frame, where each of those synchronous queries would wait for that frame's
     own draws.
     `textures.holdUploads(compile, {bind: false})` holds the maps decoded meanwhile, and the
     re-uploads of a new anisotropy (Max ↔ the rest; the tier's own maps, not Max's 4096 px
     stand-ins), until the compile is done. Then they go out one per task. The commit waits for
     the re-uploads only. A new map follows after it and becomes ready, and is bound, only after
     its upload.
  4. **Commit.** `rc.commitTier()` applies the DPR and sizes the composer. The resize clears the
     canvas, so it comes after the compile: `presentIfCleared` redraws in the same task, with
     nothing left to compile.
  5. **Resume.** The next frame draws the new tier.

  A request made while a switch is staged replaces it before anything is drawn. A compile that
  has not settled after 10 s is given up: the switch commits and the first frame compiles the
  rest, as before. A context lost meanwhile ends the compile, the switch commits, and drawing
  waits for the restore. Bloom changes between Medium, High and Max (strength, radius, threshold,
  mip scale) apply in place, without a new pass whose eight programs would compile again.
  Measured under SwiftShader at 800 × 500 after a High boot, through `actions.setQuality`. The
  figure is the longest main-thread block, from a 16 ms heartbeat, over three runs before and
  seven after, on a machine shared with other jobs. A plain redraw blocks 20–80 ms. One High →
  Medium run after the change blocked for 2.5 s; the other six stayed between 0.04 and 0.9 s.

  | Switch | Before | After | Drawing paused for |
  |---|---|---|---|
  | High → Medium | 2.7–2.8 s | 0.04–0.9 s | 2.3–6.3 s |
  | Medium → Low | 1.5–1.9 s | 0.04–0.21 s | 0.4–3.2 s |
  | Low → High | 0.1–0.9 s | 0.02–0.07 s | 0.13–0.23 s |

  The pause is about as long as the compile itself, which is the same work as before, except that
  the main thread, the panels and input stay live through it. What is left on High → Medium is a
  single program's link: the new Earth surface, cloud and atmosphere variants take 0.4–1 s each
  on SwiftShader. SwiftShader links on the CPU and has no `KHR_parallel_shader_compile`, so these
  numbers come from the paced path; with the extension the compile leaves the main thread
  altogether. High → Max pauses drawing for 3.4–4.4 s there, and its 8192 px maps bind about 12 s
  later, one upload per task. Long animation frames are no
  measure under SwiftShader: a plain redraw reports one of about 1 s, because the frame waits for
  the GPU process.
- **Previews on every tier.** `earth_day_preview.webp` and `earth_night_preview.webp` (512 × 256,
  12 and 6 KB, from the 4096 maps by `scripts/build-textures.mjs`) are the critical keys of every
  tier: they gate the loader, stand in for the day and night maps (`PREVIEW` in
  `core/texture-plan.js`) while those load or if they fail, and the Earth sharpens from them into
  the tier's maps. The earth shader samples a preview only while `uSharpen` < 1, and the close-zoom
  grain of the city lights is off on a 512 px map.
- **Decoded images.** The texture store closes each decoded `ImageBitmap` in the task after its
  upload, once its `onReady` listeners have read it: the GPU's copy is the only one. That is
  33.5 MB of RAM per 4096 × 2048 map and 134 MB per 8192 × 4096 one. Measured with SwiftShader,
  as the renderer process's resident memory once a tier's maps are in (two runs each): High
  640–647 → 561–572 MB, Max 1085 → 584 MB. The GPU process holds the same as before. Two kinds
  of map keep their image. One is marked ASSETS `keep`: the ocean masks `roughness2k` and `brc4k`,
  whose pixels `render/ground.js` samples, and the two 512 px previews (0.5 MB each), the stand-ins
  of a map that cannot be fetched again. The other is a map uploaded while the context was lost,
  which reached no GPU. An `<img>` decode (Safari) cannot be closed. A context
  restore (`restore()`, §9) and a new anisotropy (Max ↔ the rest) fetch a closed map again, from
  the HTTP or service-worker cache, and decode it into the same Texture before uploading it.
- **Coarse medium keeps the 4k day and night maps (evaluated, not changed).** The 2k pair would
  save 521 KB of download on phones (740 → 219 KB) and 67 MB of VRAM with mips (89.5 → 22.4 MB).
  Now that the decoded copies are closed, the RAM side is already gone. On a 390 px phone at
  medium's 1.5 DPR the default globe view barely changes: 38 dB PSNR against the 4k maps, 6 % less
  edge contrast. At a regional zoom (`cam=o:45,8,1.45`) the loss is plain: the day map has 32 %
  less edge contrast (30 dB), and the city lights have 35 % less (22 dB) and turn paler. A phone
  that really runs short of memory loses its context. The context-loss backoff (§9) then moves it
  to low and its 2k maps for the session.
- **One planet on every tier.** The 2k maps are the 4k maps at half size, made by
  `scripts/build-textures.mjs`: `day2k` and `night2k` from the day and night maps (filtered in
  linear light, like the GPU's own mip 1), and `clouds2k` and `roughness2k` from the blue (cloud)
  and green (water) channels of `brc4k`. The shader reads both cloud maps through one density
  curve and both water masks through one window. A Quality change or a governor step therefore
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
| `webglcontextlost` | Rendering pauses (the panels keep updating) and a non-blocking "Graphics were reset — restoring…" overlay appears. While the context is lost, `rc` disposes everything in the scenes, its stand-in quad and the whole post chain: every GL call is then a silent no-op, so only three's per-context bookkeeping goes, and a later `dispose()` never deletes the lost context's objects on the new one (no 'object does not belong to this context' warnings). On restore, `rc` builds a new chain for the current tier, `textures.restore()` fetches the maps whose decoded copy was closed again (one at a time, HTTP or service-worker cache) and uploads them, and nothing draws until that promise settles; then rendering resumes. The context reports itself lost before `webglcontextlost` is dispatched, so `rc.render`, `capture` and `compile` also check `gl.isContextLost()`: no frame draws in between (one that did made three throw, left the session on the direct path and logged a blit feedback loop on every frame after the restore). |
| A second context loss within 60 s | As above, and the session is held one tier lower (`governor.pin` and the staged tier switch) with the toast "Reduced graphics detail to keep things stable" (`core/context-loss.js`). The record is in `sessionStorage` (`app/session.js`), so a tab that reloads instead of restoring (iOS) boots at that tier. Saved preferences are untouched; choosing a tier in Display overrides it. At low there is nothing lower: it restores. |
| A third context loss within 60 s | Text mode with the "graphics kept resetting" banner; its Retry reloads with the window cleared, held at low. Until then a reload of the tab boots in text mode too, and the feature detection skips the 3D preloads. |
| A closed map cannot be fetched again on restore (or not within 15 s) | Its 512 px preview's image takes its place (day and night maps; others a 1 × 1 pixel of the placeholder colour), so no frame uploads a closed image; the key counts as failed, and the "Some imagery couldn't load." toast shows. |
| Context lost during a tier switch | The compile ends at once, the switch commits, and drawing stays paused (the `'context'` reason) until the restore, which builds the chain for the committed tier. |
| A tier switch's compile hangs | After 10 s the switch commits anyway and resumes drawing; the first frame compiles what is left. |
| A texture fails | The placeholder stays (a day or night map keeps its 512 px preview), with one "Some imagery couldn't load." toast. If the previews fail, the loader waits for the full maps instead (or 5 s). |
| `sky.json` fails | No stars or constellations, and a toast. |
| The worker fails | The client falls back to the main thread transparently. |
| All geocoders fail | Offline cities still work, and the palette shows the hint. |
| Geolocation is denied | Toast, and the location palette opens. |
| Bad hash values | They are dropped, with the toast "Some link settings were invalid." An out-of-range `t` is clamped, paused, and gets the 1000–3000 toast. |
| Slow network | After 8 s the loader offers "continue with low detail". After 40 s without code, it says so. |
| Offline, after one visit to the deployed site | Everything boots from the service worker's cache: the shell, every module (the astro worker's too), the boot data and the textures this visit's tier used. A tier never used before shows its placeholders and the imagery toast. |
| A new version deployed while the page is open | Nothing changes under the page: the old version keeps serving it from its own cache. The new one installs in the background and the toast "A new version is ready · Reload" offers to switch. |
| A deploy in the middle of an install | A file whose bytes are not the manifest's fails the install; the browser tries again on a later visit, keeping what was already verified. |
| The new version fails to boot | The loader's error panel's Reload first activates a version waiting in the worker, so a fixed deploy can replace a broken one. |

### The service worker

`sw.js` has two modes, chosen when the site is staged.

- **Staged** (the deploy). `scripts/stage-site.mjs` writes `_site/sw-manifest.json`:
  `{version, sha256, precache, fresh, files: [[path, sha256]]}`. `files` lists every shipped file
  except `sw.js` and the fresh files; `sha256` is taken over those lines plus `sw.js`'s source;
  `version` is `js/version.js`'s VERSION, `+` and its first 16 hex digits. The script stamps that
  version and `STAGED = true` into `_site/sw.js`, so any changed byte is a new worker for the
  browser's update check, and an unchanged redeploy (the daily `data/tle.json` refresh) is not.
  - `precache` is `index.html` and its local links (stylesheet, manifest, icons), the page's
    whole module graph as `scripts/check-size.mjs` budgets it (`modgraph.mjs pageModules`: static
    and dynamic imports and the astro worker's graph, ≈ 3.8 MB raw, most of which the first visit
    has already loaded), `PRECACHE_DATA` (sky, cities, spacecraft, deep-sky objects, star details,
    satellites) and the two Earth previews: 184 files, ≈ 4.5 MB. Textures and `data/stars8.json`
    stay lazy.
  - **Install** reads the manifest (its version must be the worker's), copies every file an
    older version's cache holds with the same hash, then fetches the rest (`cache: 'no-cache'`,
    so Pages answers 304 for what the HTTP cache has; once more with `reload` on a mismatch) and
    checks each hash. A missing file or another deploy's bytes fail the install. There is no
    `skipWaiting`: an update waits, and the worker posts `{type: 'update-ready'}` to open pages.
  - **Activate** deletes every other version's cache, then claims the pages.
  - **Fetch.** Every file in the manifest is cache-first within the version, `index.html`, `js/`
    and `css/` included, so a page never mixes versions. A miss (a texture) is fetched and kept
    only when its bytes match the manifest; `fresh` files are network-first (3 s, then the cache).
    Other origins (the geocoders), `sw.js` and `sw-manifest.json` are left to the browser.
- **Dev** (the repo as served by `npm start`, or a branch deploy). `VERSION` is `js/version.js`'s
  (a test checks) and there is no manifest: everything in scope is network-first and cached as it
  arrives, so edits show on reload while online and the last copy works offline.

The page side is `app/sw-client.js`. It registers the worker on secure origins when the site comes
over https from a real host, or with `#sw=1` (localhost, the smoke test); `#sw=0` unregisters it and
deletes the `pc2-` caches. After the worker is active it posts `{type: 'precache', urls}` with the
URLs this visit loaded (the first visit ran before the worker controlled it); the reply
`{type: 'precached'}` sets `__app.sw.precached`. On `update-ready`, or a version found waiting at
start, the sticky toast "A new version is ready · Reload" posts `{type: 'skip-waiting'}` to it and
reloads on `controllerchange` (or after 4 s). A version activated from another tab reloads a hidden
tab at once and offers the reload in a visible one; the state is in the hash, so a reload keeps the
view. `__app.sw` is `{version, controlled, precached, staged, waiting, …}`, and the diagnostics
report carries the version.

---

## 10. URL hash

```
#loc=21.0285,105.8542&n=Hanoi&cc=VN&tz=Asia/Ho_Chi_Minh&el=15&t=2027-08-02T10:07:00Z&r=3600&p=1
 &view=orbit&lock=1&sel=moon&ly=bgoscCnmkazhldxw&q=auto&sky=auto&cam=o:21.0,105.8,3.2&intro=0&debug=1
```

- No `t` means Live.
- `r` is the signed rate in sim-seconds per second, snapped to the ladder.
- `ly` is the exact set of enabled layers. `d` is the illustrative landscape: links made before it
  existed carry no `d`, so they open with the flat horizon. `r` is meteors (on by default; older
  links open without them) and `y` the Sun paths and analemma (off by default).
- `cam` is `o:lat,lon,dist` (the sub-camera point), `s:az,alt,fov` or, with `view=map`,
  `m:lat,lon,dist` (the map's centre and the camera's distance from the plane). An orbit distance
  past 150 R (up to 80 AU, whole radii) is the solar-system zoom: lat/lon is then its direction
  (pivot → camera) in J2000 ecliptic latitude and longitude, fixed in space, so a live link opens
  on the same view later.
- `loc2`, `n2`, `tz2` are a second place to compare with (its pin, dashed beams and Up now's
  side-by-side card). They are links only, never saved.
- `sel` selects a body or an extra object (`comet:halley`, `guest:sn1054`, `craft:voyager1`; §4) and
  opens its card (the Details tab), as a click on it would.
- `ly` letter `i` is the `satellites` layer (on by default), `v` the `spacecraft` layer (off by default), `x` the deep-sky objects (`deepSky`,
  on by default, so the default code is `bgoscCnmkazhldx`; older links without it turn it off) and
  `r` the `precession` layer (off by default). `sel=` takes `star:<hip>` and `dso:<id>` too
  (`sel=dso:M31` is lower-cased).
- `t` is always a Gregorian ISO instant, also before 1582, when the app shows the Julian date.
- `sky` is the Sky darkness setting (`display.skyDark`): `auto` (omitted), `pristine` or a Bortle class `1`–`9`.
- `au` is the Aurora activity setting (`display.aurora`): `quiet`, `typical` (omitted) or `storm`.
- `tour` starts a guided tour (`tonight`, `year`, `eclipse-2027`, `ambient`) once the app is ready,
  instead of the intro. It is read, never written: the hash shows the restored state afterwards.
- `trk` is sky-view tracking: `b` (the selected body) or `s` (the stars).
- `vt` is a vantage point: `l1` or `moon` (globe view only; `cam` is then the orbit pose it returns
  to). A link opens straight there; the Earthrise orbit is planned at the link's time, so the Earth
  stands just over the limb.
- `host=mars` stands on Mars (sky view; §4 'Standing on Mars'); `hloc=lat,lon` is the areographic
  site, planetocentric °N/°E, written only off Jezero Crater. `sel=moon:phobos` selects a moon of Mars.
- `tab` opens a panel tab (`core/store.js PANELS`: `sky`, `details`, `events`, `explore`, `display`)
  and raises the phone's sheet to half. The old tabs' ids are aliases (`PANEL_ALIASES`): `layers`
  opens Display, `settings` opens it at Sky conditions and `about` with About this app open; an
  alias is never reported invalid. Like `tour`, it is read, never written.
  The installed app's Events shortcut is `./#tab=events`; its Sky view shortcut is `./#view=sky`.
- `lang` (`en`, `vi`) sets the interface's language for this visit without saving it (§12
  'Strings and locales'); like `debug=1`, `bindUrl` keeps it in the address bar.
- Night vision (`display.red`) is never written to or read from the hash: it is a preference of
  the device you observe with (saved with the display prefs), not part of the sky being shared, so
  a link from a red screen opens in full colour (`test/app.actions.test.mjs`).

`bindUrl` writes the hash at most every 500 ms and leaves a fresh visit's URL clean. Hand edits
are applied live through `onExternalChange`. It writes nothing while a tour plays.

The installed app (`manifest.webmanifest`: wide and narrow install screenshots under
`assets/screenshots/`, the two shortcuts, `launch_handler` `focus-existing`) reuses its open
window for a shortcut or link: `main.js bindLaunchQueue` receives the target URL through
`window.launchQueue` and applies its hash like a hand edit (the page's own first launch is
skipped). `index.html` keeps the browser's `beforeinstallprompt` in `window.__pcInstall` for
About's 'Install app' (`ui/install.js`); the browser's own install UI is left alone.

---

## 11. Debugging, testing, tooling

- **`window.__app`** has `ready`, `version`, `tier` and `sw` (the service worker: version, controlled,
  precached); `snapshot()` for the full-detail snapshot;
  `stats()` returning `{fps, frames, drawCalls, geometries, textures, beamsVisible, labelsVisible,
  phase, tier, disabled}`; and `store`, `clock` and `actions`. `__app.internals` exposes the render
  objects for console spelunking. It is not a stable API.
- **`?debug=1`** in the hash, or the Backquote key, shows the debug overlay: fps, ms, draw calls,
  memory, tier.
- **The diagnostics report.** About → Copy diagnostics (`actions.copyDiagnostics()`, or
  `actions.diagnostics()` for the object; `core/diagnostics.js`) is what users paste into an
  issue: the version, `detectTier`'s decision (tier, ceiling, reason), the setting and active tier,
  the governor (start, pin, DPR cap, budget, cadence) and a log of the last 20 tier changes
  (governor steps with the EMA and budget that triggered them, `governor.lastStep`; context-loss
  step-downs), the renderer string, max texture size and DPRs, disabled modules and strike counts
  (`loop.stats().strikes`), the tab's context losses, the last 20 `window.__pcErrors`,
  `__app.stats()` and the URL hash. Never the place: only the hash keys in `DIAG_HASH_KEYS` stay
  (no `loc`, `n`, `cc`, `tz`, `el`, `loc2`, `cam`, `hloc`), and fragments, queries and `loc=` pairs
  are cut from the error lines. It is built on demand; nothing is sent anywhere.
- **`npm test`** runs the `node:test` suites: astronomy against fixtures, core and geo, data, and
  repo rules (import-map closure, purity, no external URLs, assets exist).
- **`npm run smoke`** opens the app in headless Chrome (SwiftShader) with every non-local host
  blocked. It waits for `__app.ready` and asserts no console errors, `phase === 'ready'`,
  `frames > 10`, `beamsVisible ≥ 7`, and stable geometry and texture counts while time runs at
  1 day/s. A `--url` with `sel=` must open the Details tab, and with `--mobile` the time-bar date
  and time must fit unclipped on 14 consecutive days (every weekday, one- and two-digit days).
  Useful flags: `--mobile`, `--tz=UTC`, `--reduced-motion`,
  `--media=prefers-contrast:more,forced-colors:active,prefers-reduced-transparency:reduce` (any
  feature CDP `Emulation.setEmulatedMedia` knows), `--subpath=/repo/`,
  `--url=/#…`, `--out=shot.png`, `--eval="js"` (awaited before the screenshot). For the failure
  matrix and the intro: `--no-webgl` (text mode), `--init="js"` (runs before the page, e.g.
  `HTMLScriptElement.supports=()=>false` for no import maps), `--fail=data/sky.json,earth_day`
  (those requests get HTTP 404 and are not judged), `--at=1000,3000` (timed screenshots
  `<out>-<ms>.png`; the run then skips its wait for the intro to finish) and `--throttle=150,9000`
  (a slow network: round-trip ms and kbit/s, through CDP `Network.emulateNetworkConditions`).
- **`--offline-reload`** (smoke) opens the page with `#sw=1`, waits for the worker to control it
  and reply `precached` (on a staged `--root`: the manifest's version, every precache file cached),
  then goes offline (CDP `Network.emulateNetworkConditions` and the server stops) and reloads. The
  reload must get ready, receive the astro worker's events, show no imagery toast and be served by
  the worker alone, and the acceptance checks then run offline. CI runs it on the staged site under
  the Pages sub-path (`node scripts/stage-site.mjs _site`, then `--root=_site`;
  `node scripts/serve.mjs --root=_site` serves the same copy). **`--context-loss`** loses and
  restores the WebGL context (`WEBGL_lose_context`) once the app is ready: the overlay must show
  and leave, five frames be drawn and no WebGL warning appear (CI: at Medium, and after the
  perf gates at Low and High).
- **Performance gates** (`--perf[=tier]`, `scripts/lib/perf-gates.mjs`) gate on counts, never on
  milliseconds: CI runners are noisy and SwiftShader is slow, but a count moves only when the
  code does. An init shim wraps `requestAnimationFrame` to count `getBoundingClientRect` and
  `getClientRects` calls made inside frame callbacks, and records long animation frames. Once the
  app is ready, a probe pauses the clock and waits for the globe to settle (supersampling history
  full, no frame for 1.5 s), then checks:
  - shader programs (`renderer.info.programs`) and the draw calls of a settled frame, globe and
    sky view, within `PERF_BUDGETS` for the tier. These were measured on `perfScene` (Ho Chi Minh
    City at 22:00 local on 4 Nov 2026, paused), plus about 10 %. The 2026-11-04 baseline was
    low 48 programs, 21 and 12 draws; medium 59, 39 and 28; high 59, 40 and 28;
  - no frame in 3 s on the paused globe;
  - no frame in 3 s in the paused sky view, except on a tier that twinkles the stars: there at
    most 32 a second, and never two frames closer than `TWINKLE_FRAME_MS − 2`;
  - no layout read inside a frame callback during a 3 s time-lapse at 1 h/s (§7 'Labels': the
    labels, the time bar and the view insets all read after the frame).

  The boot's longest long animation frame is printed, not judged: on SwiftShader it is the shader
  compile, 2.5–9 s here depending on tier and machine load. A new feature that adds programs or
  draw calls raises its tier's budget deliberately, with a dated note, like the size budgets. CI
  runs `--perf=low --context-loss` at 1440×900 and `--perf=high --context-loss` at 320×240.
  At 1440×900 SwiftShader draws a High sky view only every 70 ms or more, which never tests the
  30 Hz twinkle cap; at 320×240 it draws every 33 ms. The counts are the same at both sizes.
- **Golden renders** (`node scripts/golden.mjs`, `scripts/lib/golden.mjs`) are the visual
  regression check. Eight scenes (`--list`) are each opened in a fresh browser profile:
  - Ho Chi Minh City at night (High and Low), the totality of 2 Aug 2027 at Luxor (globe and sky
    view, High), Paris at sunset (sky view, High), and the phone's Medium (390×844 @3, globe and
    the Luxor sky);
  - all paused, with no intro, reduced motion (no twinkle) and the labels and satellites layers
    off. Labels are DOM text, and fonts decide which planet medallions show. `data/tle.json` is
    refreshed;
  - text mode (WebGL disabled).

  A scene settles first: textures in, no request (and in text mode no DOM change) for 2 s,
  supersampling done, no frame drawn. Then everything but `#scene` is hidden, and the canvas is
  captured at its own pixels: the phone at 585×1266, the desktop scenes at half size, 720×450.
  A scene fails when more than 0.5 % of its pixels move by more than 6/255 in luma, and its
  `<scene>.diff.png` heat map shows the golden dimmed with the changed pixels from red to yellow.
  Text mode's golden is its visible structure: one line per element with an id, a role or an
  aria-label, digits masked, hidden subtrees left out. It is compared line by line.

  Two renders on one machine are pixel-identical. A beam glow of 10 px instead of 8 on Low moves
  2.26 % of that scene. Renders depend on the browser build, so `test/golden/meta.json` records
  the Chrome version, platform and WebGL renderer. A run with no goldens, or another Chrome,
  platform or renderer, skips with a notice and exits 0. CI pins Chrome for Testing
  (`CHROME_VERSION` in `.github/workflows/ci.yml`, installed by `browser-actions/setup-chrome`)
  for every browser step, and the goldens are made there, never on a developer machine:
  **to make or update the goldens**, run the CI workflow by hand (Actions → CI → Run workflow)
  with **Render goldens** ticked. Download the `goldens` artifact, replace `test/golden/` with
  its contents and commit. Do the same after a deliberate visual change (the failing run's
  `golden-renders` artifact shows what moved) and after raising `CHROME_VERSION`. Locally,
  `--update` (and `--only=a,b`, `--dir=`) writes goldens for your own Chrome, which is useful to
  compare two versions of a change; CI skips such goldens unless they come from the pinned build.
- **`npm run size`** enforces the per-tier transfer budgets (low 5.2 MB, medium 5.975 MB, high
  8 MB raw, re-baselined from the spec's estimate to the measured unminified module graph, last
  when the Phase 7 lanes merged; low and medium stay under 6 MB, high under 8 MB) and the 32 MB
  deploy limit. Max (≈ 22.3 MB) is reported but has no budget; its 8192 px maps (≈ 15.2 MB) are why
  the deploy limit went from 12 to 32 MB (the staged site is ≈ 24.7 MB; GitHub Pages allows 1 GB).
- **`npm run preload`** (`node scripts/lib/modgraph.mjs --write`, `--check` to verify) regenerates
  index.html's boot modulepreload lists (§3 'Early downloads').
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
- Copy that names keys has a touch twin: `.for-fine` and `.for-coarse` elements switch on
  `body.is-coarse` (css/app.css section 20), which also hides key caps and key hints on touch
  (the help dialog's key table keeps them).
- **Night vision** (`html.is-red`, css/app.css section 20) is one CSS filter on the whole page,
  `brightness(.042) sepia(1) saturate(100)`: three colour-matrix functions, never an SVG
  `url()` filter (those leave the GPU path in Safari and Firefox). sepia(1) projects every colour
  onto one hue at a weighted luminance (.29 R + .57 G + .14 B); saturate(100) pushes that hue's
  green and blue below zero, where they clamp, and its red to 62 % of the luminance; the first
  brightness keeps every step below 1. Measured in headless Chrome: G = B = 0 and 159 red levels.
  `test/ui.night-vision.test.mjs` evaluates the chain with the Filter Effects matrices, so a tweak
  that leaks green or clips is caught. Cost: in-app frame rates on SwiftShader did not move
  (≈ 2.5–2.8 fps at 560×360, WebGL-bound either way); in software compositing each function costs
  a pass (a DOM-only page fell from ≈ 58 to 13 fps with this chain, 7 with a six-function one), so
  the chain is kept short. Real GPUs run it as one colour-matrix pass over the page. Copy that
  relies on colour alone reads poorly in red (the accent becomes just a brightness), so a state in
  a menu says it in words ('On: choose again for full colour'), and checked menu rows carry ● or ✓.
- **The visual system** (docs/roadmap/UI-REDESIGN.md §9.1): `:root` holds the type, weight,
  spacing, radius and control-height tokens (`--fs-1…5`, `--fw-1…3`, `--sp-1…5`, `--r-s/m/l`,
  `--h-ctl`, `--h-chip`, `--nav-h`, `--surface-solid`). Every `font-size`, `font-weight` and
  `border-radius` is a token (two exemptions: the phone's 18-px clock and the globe's 10-px
  constellation names); spacing uses `--sp-*` in new and rewritten rules. Help text is one
  class, `.note`; status is `.badge` (tones `ok`, `accent`, `warn`, `muted`; `--dot`, and `--live`
  for the time bar's LIVE); interactive pills are `.chip`. The eyebrow is for group titles only. A selected
  state never relies on colour alone (§9.5): the active tab and a checked segment are also
  `--fw-3` (the segment with an inset `--line-2` ring), a pressed toggle (`.btn--toggle`) swaps
  its icon for a ✓, a checked radio chip gets a ✓, menu rows ● or ✓. `body.is-coarse` raises
  `--h-ctl` and `--h-chip` to 44 px and gives every interactive element a 44-px minimum (menu rows
  52, switch rows 48; globe labels a 32-px hit slop).
- **Contrast.** Secondary text (`--muted`, `--faint`) keeps 4.5:1 on the panels, also in sky view
  over a pale daytime sky, where the blur tiers' glass is .9 opaque and `--faint` a step lighter
  (`body.is-sky`); `test/ui.a11y-css.test.mjs` computes it from the tokens. Focus rings are the
  accent outline plus a dark 5-px halo (`.ui :focus-visible`), visible over the sky and in panels.
- **System preferences** (css/app.css section 22): `prefers-reduced-transparency: reduce` makes
  the panel tokens opaque and drops every backdrop blur; `prefers-contrast: more` brightens
  `--text-2`, `--muted` and `--faint` (≥ 7:1), makes panels opaque and edges panels, chips,
  segments and soft buttons with `--line-2`; `forced-colors: active` gives panels and controls
  system-colour edges and draws fill-only states (switches, segmented choices, pressed chips, the
  active tab's ink, the time bar's thumb, the Tools button's in-use dot, pressed toggles) in
  `Highlight` and underlines the selected tab and menu row, keeps canvases on a dark ground and
  leaves the scene's labels (`#labels-root`, over the unforced 3D view) in their own colours. New
  controls whose state is only a background need a line there. Override selectors include
  `body.is-sky` where the sky view sets the same token.

### Strings and locales (`js/core/i18n.js`)

The interface speaks English and Vietnamese. gettext style: **the English source text is the key**.

- **A string.** `import { t } from '../core/i18n.js'` once per module and write the whole phrase,
  placeholders included: `t('Observer set to {place}', { place })`. Never build a sentence from
  fragments (word order differs); a phrase holding DOM nodes goes through `tpl(t('Press {key} to
  search'), { key: kbd('K') })` (js/ui/dom.js). Counts take `tn('{n} world above you', '{n} worlds
  above you', n)`; the table's key is the `other` form. aria-labels, titles, `data-tip`s,
  placeholders, toasts, announcements and alt text count. Key names on key caps stay keys.
- **A table's string.** Module-level tables are built before the locale is set, so mark their
  strings `N_('Beams')` (an identity) and translate where they are shown: `t(item.label)`. Never
  call `t()` at module level. `t(name)` of a string the table lacks (a city, a comet) is that
  string, so names can always pass through it. Several tables share one English source:
  `astro/bodies.js` names, `ui/layers.js LAYER_GROUPS` (Display, the help table, the shortcut
  flashes), `ui/shell.js TABS`, `ui/timebar.js STEP_UNITS`.
- **No local `t`.** A module that imports `t` never names a variable or parameter `t` (it would
  shadow the import, or throw in its temporal dead zone); the repo test checks it.
- **Then** add the translation to `data/i18n/vi.json` (`{"English": "Tiếng Việt"}`, keys sorted).
  `test/repo.i18n.test.mjs` extracts every `t`/`tn`/`N_` literal from js/ and fails on a missing
  key, a placeholder mismatch, an empty translation, unsorted keys, a key no source uses any more,
  or a `t()` of a template literal with `${}` (a key that cannot be looked up). A missing key falls back to English
  silently.
- **Numbers and dates.** User-visible numbers go through `core/format.js` (`fmtNum`, `fmtInt`,
  `fmtDeg`, `fmtMag`, `fmtDistKm`, `fmtDuration`…): Vietnamese has a decimal comma, dot grouping,
  and '; ' between coordinates. Dates and times go through `dateText`/`timeText` (the UI hub's
  `fmtDay`, `fmtClock`, `fmtWhen`…): English keeps its designed form ('Sun 11 Oct 2026', '8:14 PM',
  Intl en-US names); other locales use `Intl.DateTimeFormat(locale).formatToParts` on the
  calendar's fields, with the weekday from the fields, so Julian dates before 1582 stay right.
  Machine formats never change: the URL hash, .ics, CSV, diagnostics, the GitHub issue template.
  The hub's `ui.fmtDate(ms, opts, tz)` takes Intl's options for any other shape ('October 2026').
  Where space is tight outside English the time bar uses Intl's compact forms: ticks 'T3 14', the
  phone's date 'T5, 5/11/2026'.
- **Layout.** Vietnamese runs about a quarter longer. `:lang(vi)` rules in css/app.css absorb the
  few places that need it (the phone's LIVE pill); prefer a layout that wraps over a per-language
  rule.
- **Choosing.** `#lang=vi|en` (this visit only; the address bar keeps it), then the saved choice
  (pref `lang`, Display → Language · Ngôn ngữ), then `navigator.language` ('vi…' → Vietnamese),
  else English. At boot `main.js` fetches `data/i18n/<code>.json` alongside the UI module and
  `setLocale`s it before `mountUI`; if it fails within 3 s the interface mounts in English with a
  toast (in English). `<html lang>` follows. Changing the language in Display saves the pref,
  drops `#lang=` and **reloads**: the page is built in one language, and the state survives in the
  hash. English costs no table; vi.json is fetched only when Vietnamese is active (it is not in
  the service worker's precache: the warm-up message caches it on a Vietnamese visit).
- **Names.** Constellations keep their IAU Latin names and stars their proper names (Sirius,
  Vega); the Sun, Moon and planets are translated (Mặt Trời, Mặt Trăng, Sao Thủy…).
- **The astro worker.** It has its own module instance, so `client.js` posts the active locale
  and table as the worker's first message (op `locale`; the locale only changes by reload) and
  worker-side `t()` works. Prefer returning structured fields (a kind and its values) and
  writing the sentence in js/ui; text the worker builds (almanac and event sentences) uses `t()`
  with the posted table.
- **A new locale.** Add it to `LOCALES` (its own name) and `TAGS` in i18n.js, add
  `data/i18n/<code>.json` with every key, a `FILE_BUDGETS` entry in scripts/check-size.mjs, and
  the test's `TABLES`. Plural forms beyond one/other are objects keyed by Intl.PluralRules
  categories (`{"one": …, "few": …, "other": …}`).
