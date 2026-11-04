# Graph Report - mars-location-marker  (2026-11-04)

## Corpus Check
- 212 files · ~431,709 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 7 file(s) not represented in the graph (top: (none) 5, .css 1, .webmanifest 1)

## Summary
- 3149 nodes · 8181 edges · 121 communities (118 shown, 3 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 393 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e6ed0cf0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- createRig
- The astronomy behind Planet Location Marker (ASTRONOMY.md)
- tours.js
- render/bodies.js
- Beams & Labels
- Events & Trails
- UI Hub & Shortcuts
- Time Bar & Scrubber
- Headless Smoke Harness
- App Actions API
- Body Card & Sky Now
- Shell, Icons & About
- repo.purity.test.mjs
- labels-feed.js
- URL Hash State
- createRenderContext
- Boot sequence (10 steps)
- Milky Way Build
- Frames & Moon Orientation
- Snapshot & Eclipse Geometry
- check-size.mjs
- astro/orrery.js
- City Data Build
- vantage.js
- Vendor Pinning
- Sky Lines & Exposure
- Almanac & Verdicts
- Simulation Clock
- Quality Tiers & Governor
- Icon Generator
- earth.js
- h
- Cinematic Intro
- worker.js
- repo.textures.test.mjs
- ref_node_test
- Offline Cities
- astro/eclipse-path.js
- Preferences Storage
- Online Geocoder
- Star Catalogue Build
- Clock Rates & Limits
- Sky Module
- Package Scripts
- Static Dev Server
- Geocoder Tests
- ground.js
- Globe Picking
- photometry.js
- Coordinate Parsing
- main.js
- Frame Loop & Strikes
- State Store
- ref_node_fs
- Retrograde Paths
- recorder.js
- Worker Client
- astro/skyglow.js
- Layout Shell
- Event Search Tests
- Shader Domain Test
- Planet Location Marker architecture (ARCHITECTURE.md)
- Snapshot Detail Levels
- Snapshot Tests
- rig.js
- City Search Matching
- eyepiece.js
- astro.shadow.test.mjs
- geomag.js
- tz.js
- actions.js
- Service Worker
- setAttr
- Debug Overlay
- camera.rig.test.mjs
- astro/totality.js
- stepToOrbit
- horizon.js
- createPlanets
- clamp
- app.eclipse-chase.test.mjs
- aim.js
- postcard.js
- sky-guide.js
- astro/bodies.js
- moons.js
- Planet Location Marker
- render/totality.js
- trails.js
- planets.js
- createGovernor
- createLabels
- Roadmap: v2.1 "breathtaking"
- flare.js
- ref_three
- render/eclipse-path.js
- labels.js
- createEyepiece
- createBus
- astro.skyglow.test.mjs
- three-hooks.mjs
- app.capture.test.mjs
- sampling.js
- geo.mapview.test.mjs
- setText
- capture.js
- ruler.js
- camera.system.test.mjs
- edge-chips.js
- aurora.js
- applyViewNow
- common.glsl.js
- moonAppulses
- core.url-state.test.mjs
- fallback.js
- AccumPass
- createTextureStore
- astro.frames.test.mjs
- vantageOwns
- importRenderStack
- SupersamplePass

## God Nodes (most connected - your core abstractions)
1. `createRig()` - 121 edges
2. `computeSnapshot()` - 86 edges
3. `createActions()` - 73 edges
4. `h()` - 66 edges
5. `createSnapshot()` - 58 edges
6. `setText()` - 55 edges
7. `boot()` - 51 edges
8. `clamp()` - 46 edges
9. `icon()` - 46 edges
10. `mountTimebar()` - 44 edges

## Surprising Connections (you probably didn't know these)
- `Three-strikes module guard` --references--> `STRIKES_TO_DISABLE`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/loop.js
- `Text mode (no WebGL2 / no import maps fallback)` --references--> `showFallback()`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/fallback.js
- `Frame vs full snapshot detail (0.5 s staleness, 4 Hz readout)` --references--> `SNAP_STALE_MS`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/loop.js
- `Frame vs full snapshot detail (0.5 s staleness, 4 Hz readout)` --references--> `FULL_INTERVAL_MS`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/loop.js
- `Label anchors, priorities and UI occluders` --references--> `ORBIT_LABEL_CAP`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/loop.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Earth orientation pipeline (GAST + precession/nutation through S)** — docs_astronomy_gast, docs_astronomy_iau2006_precession, docs_astronomy_iau2000b_nutation, docs_astronomy_s_mapping, docs_astronomy_earth_matrix, docs_astronomy_earth_fixed_frame, docs_astronomy_static_sky [EXTRACTED 1.00]
- **Hard repo rules R1–R7 enforced by tests** — docs_architecture_rule_pure_modules, docs_architecture_rule_three_confinement, docs_architecture_rule_ui_isolation, docs_architecture_rule_relative_urls, docs_architecture_rule_no_per_frame_allocation, docs_architecture_rule_shader_tonemapping, docs_architecture_rule_vector_conventions [EXTRACTED 1.00]
- **Boot-time failure and text-mode fallback chain** — index_global_error_capture, index_pcloader, index_pcenv, docs_architecture_text_mode, js_app_fallback, js_main_entertextmode, docs_architecture_failure_matrix [INFERRED 0.85]
- **Boot-time failure and text-mode fallback chain** — index_pcenv, index_global_error_capture, index_inline_loader, index_pcloader, docs_architecture_text_mode, docs_architecture_failure_matrix, docs_architecture_dynamic_import_split [INFERRED 0.85]

## Communities (121 total, 3 thin omitted)

### Community 0 - "createRig"
Cohesion: 0.13
Nodes (35): createRig(), afterTransition(), applyInsets(), captureMapFrame(), defaultLook(), dropVantage(), emitInteract(), flyToDirNow() (+27 more)

### Community 1 - "The astronomy behind Planet Location Marker (ASTRONOMY.md)"
Cohesion: 0.09
Nodes (36): The astronomy behind Planet Location Marker (ASTRONOMY.md), Accuracy budget, Airmass and extinction (Kasten–Young, k = 0.2 mag), IAU WGCCRE rotational elements (Archinal et al. 2018), Disc-overlap eclipse model (discVisible), earthMatrix = S·(PN·Rz(GAST))·Sᵀ, Eclipse-dimmed magnitudes (Sun obscuration, lunarEclipseLight quadrature), EQD frame (true equator and equinox of date) (+28 more)

### Community 2 - "tours.js"
Cohesion: 0.05
Nodes (94): telescopeFov(), ambientSteps(), clamp(), createTourRunner(), applyStep(), applyTime(), bindInput(), build() (+86 more)

### Community 3 - "render/bodies.js"
Cohesion: 0.14
Nodes (18): ATM_BETA_R, DISC_BLENDING, EXT_K, FALLBACK_MAG, MOON_MAP_GAIN, SUN_CORE, SUN_CORONA, SUN_GLOW (+10 more)

### Community 4 - "Beams & Labels"
Cohesion: 0.06
Nodes (53): umbraNear(), enuLocal(), latLonToLocal(), buildStrip(), createBeams(), apply(), boxAt(), computeAnchors() (+45 more)

### Community 5 - "Events & Trails"
Cohesion: 0.11
Nodes (44): Events search (quarters, oppositions, elongations, eclipses, seasons), compass16(), appulseEvent(), cap(), centralDurS(), centralPhaseUp(), clockFormatters, constellationOf() (+36 more)

### Community 6 - "UI Hub & Shortcuts"
Cohesion: 0.07
Nodes (50): mountAnnouncer(), flush(), say(), createEmitter(), prefersReducedMotion(), COMPASS16, COMPASS_WORDS, createUiHub() (+42 more)

### Community 7 - "Time Bar & Scrubber"
Cohesion: 0.07
Nodes (54): clamp(), buildLut(), C_ASTRO, C_CIVIL, C_DAY, C_NAUT, C_NIGHT, C_NOON (+46 more)

### Community 8 - "Headless Smoke Harness"
Cohesion: 0.10
Nodes (35): acceptance(), args, argText(), ASSERT, check(), checks, cleanup(), describeRun() (+27 more)

### Community 9 - "App Actions API"
Cohesion: 0.07
Nodes (35): clamp(), createActions(), bodyNow(), camDistance(), copyText(), cycleTracking(), cycleView(), eclipsePathFor() (+27 more)

### Community 10 - "Body Card & Sky Now"
Cohesion: 0.08
Nodes (53): localSolarEclipseAt(), compareSight(), angSize(), drawPhaseDisc(), EQUIPMENT, hexRgb(), KIND_LABEL, lowerFirst() (+45 more)

### Community 11 - "Shell, Icons & About"
Cohesion: 0.09
Nodes (39): BODIES, ovalSummary(), CREDITS, mountAbout(), on(), svgNS(), switchRow(), eventColor() (+31 more)

### Community 12 - "repo.purity.test.mjs"
Cohesion: 0.09
Nodes (19): CI workflow (ci.yml), Generated-data freshness check (build-sky / build-milkyway --check), Deploy to GitHub Pages workflow (pages.yml), blank(), KEYWORDS_BEFORE_REGEX, lineAt(), PUNCT_BEFORE_REGEX, scanJs() (+11 more)

### Community 13 - "labels-feed.js"
Cohesion: 0.07
Nodes (45): bodyAnchors(), bodyLabelOffsets(), buildAnchors(), cardinalAnchors(), CARDINALS, clamp(), constellationAnchors(), createLabelsFeed() (+37 more)

### Community 14 - "URL Hash State"
Cohesion: 0.14
Nodes (32): URL hash format (loc, t, r, sel, ly, cam, q), bindUrl(), schedule(), write(), BODY_IDS, CAM, camToCode(), clamp() (+24 more)

### Community 15 - "createRenderContext"
Cohesion: 0.17
Nodes (25): createRenderContext(), beginCapture(), capture(), captureCamera(), chainCfg(), compile(), dispose(), endCapture() (+17 more)

### Community 16 - "Boot sequence (10 steps)"
Cohesion: 0.14
Nodes (13): Architecture, Development, graphify, What this is, Boot sequence (10 steps), Observer fallback chain (hash -> prefs -> largest city in device tz -> Greenwich), byTz(), placeToObserver() (+5 more)

### Community 17 - "Milky Way Build"
Cohesion: 0.09
Nodes (38): addSpan(), blur(), buildEdges(), distanceField(), dt1d(), fillLevel(), gaussianKernel(), H (+30 more)

### Community 18 - "Frames & Moon Orientation"
Cohesion: 0.07
Nodes (11): COS_OBL, dirToAltAz(), dot3(), earthFixedToEqj(), earthRotationM3(), sceneToRaDec(), SIN_OBL, toAeTime() (+3 more)

### Community 19 - "Snapshot & Eclipse Geometry"
Cohesion: 0.06
Nodes (42): AU_ER, LIGHT_S_PER_AU, angleBetween3(), m3ToSceneM4(), m4MulDir(), m4MulDirT(), m4ToQuat(), OBLIQUITY_J2000_DEG (+34 more)

### Community 20 - "check-size.mjs"
Cohesion: 0.08
Nodes (39): Per-tier transfer budgets (3.8 / 4.3 / 5.4 MB, 12 MB deploy), FALLBACK_ASSETS, FALLBACK_TIERS, FILE_BUDGETS, fmt(), INFO_TIERS, INTERIM, main() (+31 more)

### Community 21 - "astro/orrery.js"
Cohesion: 0.05
Nodes (60): clamp(), COS_E, createSystemPose(), ECL_NORTH_S, ECL_X_S, ECL_Y_S, edgeExit(), GLOBE_MAX_R (+52 more)

### Community 22 - "City Data Build"
Cohesion: 0.11
Nodes (25): buildCities(), byPopDesc(), CACHE, ensureSources(), FIELDS, main(), normaliseZones(), OUT (+17 more)

### Community 23 - "vantage.js"
Cohesion: 0.08
Nodes (36): aboveLimbDeg(), _c, createLunarPlan(), createPose(), earthAboveLimbDeg(), EARTHRISE_DEG, EARTHRISE_FOV_DEG, ECL_POLE_S (+28 more)

### Community 24 - "Vendor Pinning"
Cohesion: 0.11
Nodes (26): addon(), AE, checkEntry(), D3C, DERIVED_LOCK, listFiles(), LOCK, main() (+18 more)

### Community 25 - "Sky Lines & Exposure"
Cohesion: 0.08
Nodes (32): raDecToScene(), GROUND_FRAG, GROUND_VERT, LANDSCAPE_CHUNK, SEA_CHUNK, SKY_PATCHES, TWILIGHT_CHUNK, EXTINCTION_CHUNK (+24 more)

### Community 26 - "Almanac & Verdicts"
Cohesion: 0.10
Nodes (40): aeObserverOf(), attempt(), classifySamples(), COMPASS, DAYTIME_CAPABLE, decideVerdict(), equipmentFor(), fmtMag() (+32 more)

### Community 27 - "Simulation Clock"
Cohesion: 0.26
Nodes (23): clamp01(), clampT(), createClock(), advanceRange(), clampStop(), effRate(), endRange(), flush() (+15 more)

### Community 28 - "Quality Tiers & Governor"
Cohesion: 0.16
Nodes (19): Quality tiers (low / medium / high), ALL_TIERS, autoStartTier(), CADENCE_PROBE_TICKS, CADENCE_STALE_MS, deepFreeze(), detectTier(), isAutoTier() (+11 more)

### Community 29 - "Icon Generator"
Cohesion: 0.14
Nodes (20): compilePaint(), compileShape(), design(), DIR, EARTH, ellipseDistance(), fmt(), hexRgb() (+12 more)

### Community 30 - "earth.js"
Cohesion: 0.13
Nodes (28): CLOUD_DRIFT_EPOCH_MS, createEarth(), bindSlot(), bindTier(), clearSlot(), refreshClouds(), refreshVisibility(), want() (+20 more)

### Community 31 - "h"
Cohesion: 0.10
Nodes (38): debounce(), instances, append(), applyAttrs(), BOOL_ATTRS, FOCUSABLE, focusables(), h() (+30 more)

### Community 32 - "Cinematic Intro"
Cohesion: 0.22
Nodes (19): easeInOutCubic(), easeOutQuart(), INTRO_TIMING, introStartDir(), mulDir(), mulDirT(), normalize(), playIntro() (+11 more)

### Community 33 - "worker.js"
Cohesion: 0.21
Nodes (11): BODY_IDS, moonOrbitPolyline(), orbitPolylines(), put32(), handleMessage(), runOp(), serializeError(), transferablesOf() (+3 more)

### Community 34 - "repo.textures.test.mjs"
Cohesion: 0.10
Nodes (20): build(), checkDerived(), DERIVED_LOCK, imageSize(), isCachedSource(), main(), readLockFile(), readOrNull() (+12 more)

### Community 35 - "ref_node_test"
Cohesion: 0.08
Nodes (12): labelMode(), MAP_HIDE_K, CAPE, PARIS, snapAt(), FakeCanvas, flush(), HCMC (+4 more)

### Community 36 - "Offline Cities"
Cohesion: 0.14
Nodes (12): ALIASES, boundedDistance(), DEFAULT_FIELDS, placeLabel(), QUALIFIER_ALIASES, rowA, rowB, rowC (+4 more)

### Community 37 - "astro/eclipse-path.js"
Cohesion: 0.06
Nodes (51): aimAtEvent(), SUN_RADIUS_KM, aeTime(), axisHit(), axisW, bisectEdge(), cA, cB (+43 more)

### Community 38 - "Preferences Storage"
Cohesion: 0.25
Nodes (15): clearAll(), isPlainObject(), kindOf(), load(), memory, persistent(), PREF_KEYS, PREFIX (+7 more)

### Community 39 - "Online Geocoder"
Cohesion: 0.22
Nodes (14): createGeocoder(), query(), search(), setStatus(), finite(), makePlace(), nominatim, openMeteo (+6 more)

### Community 40 - "Star Catalogue Build"
Cohesion: 0.21
Nodes (14): buildCons(), buildNames(), buildSky(), buildStars(), main(), OUT, packPolyline(), packRa() (+6 more)

### Community 41 - "Clock Rates & Limits"
Cohesion: 0.16
Nodes (14): BIT, easeRange(), EVENT_ORDER, logEase(), MAX_MS, MAX_RATE, MIN_MS, nextRate() (+6 more)

### Community 42 - "Sky Module"
Cohesion: 0.21
Nodes (12): createSky(), apply(), applyMagLimit(), dispose(), refreshDetail(), setCatalog(), setHighlight(), setQuality() (+4 more)

### Community 43 - "Package Scripts"
Cohesion: 0.11
Nodes (17): name, private, scripts, data, icons, size, smoke, smoke:mobile (+9 more)

### Community 44 - "Static Dev Server"
Cohesion: 0.20
Nodes (10): createStaticServer(), MIME, mimeFor(), normalisePrefix(), resolveRequest(), statOrNull(), app, args (+2 more)

### Community 45 - "Geocoder Tests"
Cohesion: 0.15
Nodes (8): PROVIDERS, EMPTY, fakeFetch(), hostOf(), NOMINATIM, ok(), OPEN_METEO, PHOTON

### Community 46 - "ground.js"
Cohesion: 0.22
Nodes (21): createHorizonGlow(), umbraHorizonGlow(), urbanIndex(), extinctionRGB(), clamp(), createGround(), apply(), dispose() (+13 more)

### Community 47 - "Globe Picking"
Cohesion: 0.17
Nodes (17): Earth-fixed frame (EF), localToLatLon(), raySphere(), _d, _hit, _l, _ll, ndcXY() (+9 more)

### Community 48 - "photometry.js"
Cohesion: 0.13
Nodes (22): Ballesteros (2012) black-body colours, Star colour from B−V (Ballesteros + Planck × CIE 1931), adaptingLuminance(), buildBvLut(), bvToKelvin(), bvToRgb(), cieX(), cieY() (+14 more)

### Community 49 - "Coordinate Parsing"
Cohesion: 0.25
Nodes (11): decimalCommas(), fromHemisphereGroups(), groupByHemisphere(), groupPlain(), groupValue(), normalise(), parseLatLon(), tokenize() (+3 more)

### Community 50 - "main.js"
Cohesion: 0.08
Nodes (57): eclipseFocusExpired(), selectionLook(), viewModeLook(), photoLayers(), bodyById(), isBodyId(), createLruCache(), AIM_STOP_TOASTS (+49 more)

### Community 51 - "Frame Loop & Strikes"
Cohesion: 0.21
Nodes (20): createLoop(), broadcast(), callModule(), computeSecond(), disable(), feedCadence(), fillSkyglow(), frame() (+12 more)

### Community 52 - "State Store"
Cohesion: 0.22
Nodes (9): AURORA_SETTINGS, deepFreeze(), DEFAULT_STATE, freezeShallow(), isPlainObject(), mergeSlice(), SKY_DARK_SETTINGS, VANTAGE_SETTINGS (+1 more)

### Community 53 - "ref_node_fs"
Cohesion: 0.08
Nodes (8): ROOT, ROOT, ALTS, ASPECTS, C, rig, ROOT, sky

### Community 54 - "Retrograde Paths"
Cohesion: 0.14
Nodes (17): Retrograde paths and stationary points, AE, wrap180(), apparentPath(), bisectStation(), eclLonAt(), geoVector(), GHOST_DAYS (+9 more)

### Community 55 - "recorder.js"
Cohesion: 0.13
Nodes (27): expose(), nextDarkMs(), trailsLook(), box(), createMp4Muxer(), moov(), stsd(), mp4Boxes() (+19 more)

### Community 56 - "Worker Client"
Cohesion: 0.31
Nodes (12): abortError(), createAstroClient(), call(), dispose(), eclipsePath(), ensureWorker(), onMessage(), pump() (+4 more)

### Community 57 - "astro/skyglow.js"
Cohesion: 0.08
Nodes (36): limitingMag(), smoothstep(), BORTLE_SQM, BORTLE_SQM_MIN, bortleFromSqm(), cityCoreGlow(), cityRadiusKm(), computeSkyglow() (+28 more)

### Community 58 - "Layout Shell"
Cohesion: 0.41
Nodes (12): mountShell(), applyLayout(), computeLayout(), measureSheet(), measureTimebar(), openPanel(), placeInk(), selectTab() (+4 more)

### Community 59 - "Event Search Tests"
Cohesion: 0.12
Nodes (13): clockFormatter(), upcomingEvents(), eclipseAt(), from2024, from2026, fromJune2027, HANOI, hanoi2024 (+5 more)

### Community 60 - "Shader Domain Test"
Cohesion: 0.24
Nodes (10): firstArgs(), KNOWN_CLAMPED_TRIG_ARGS, KNOWN_POSITIVE_BASES, KNOWN_SAFE_LOG_ARGS, ourGlsl(), read(), ROOT, SHADER_DIR (+2 more)

### Community 61 - "Planet Location Marker architecture (ARCHITECTURE.md)"
Cohesion: 0.11
Nodes (26): Planet Location Marker architecture (ARCHITECTURE.md), Body classes (is-ready, is-sky, tier-*, no-webgl, is-intro), Failure handling matrix, Globe <-> sky transition (skyBlend, groundCover, descent pitch-up), RenderModule contract (object3d, apply, update, setLayers, setViewMode, setSelection, setQuality, dispose), Fixed render order (SPEC §E.1), Headless Chrome smoke test (all external hosts blocked), Text mode (no WebGL2 / no import maps fallback) (+18 more)

### Community 62 - "Snapshot Detail Levels"
Cohesion: 0.09
Nodes (27): Frame vs full snapshot detail (0.5 s staleness, 4 Hz readout), State and data flow (UI -> actions -> store -> render modules; clock -> loop), FEATURE_NAMES, FINE_FOV_DEG, FULL_INTERVAL_MS, MAX_DT_MS, OPT_FRAME, OPT_FULL (+19 more)

### Community 63 - "Snapshot Tests"
Cohesion: 0.17
Nodes (4): CONTACT_CASES, FULL, HONOLULU, numbersIn()

### Community 64 - "rig.js"
Cohesion: 0.05
Nodes (42): _bF, _bR, _bU, DESCENT_BLEND, DESCENT_PITCH, DESCENT_TURN, _fF, _fG (+34 more)

### Community 65 - "City Search Matching"
Cohesion: 0.42
Nodes (9): foldText(), loadCities(), aliasTargets(), fuzzyDistance(), nearest(), qualifies(), search(), tierOf() (+1 more)

### Community 66 - "eyepiece.js"
Cohesion: 0.11
Nodes (25): ringAt(), ALB, albedo(), band(), C_BELT, C_GRS, C_POLE, C_TAN (+17 more)

### Community 67 - "astro.shadow.test.mjs"
Cohesion: 0.14
Nodes (18): MOON_RADIUS_ER, SUN_ANG_RADIUS_1AU_RAD, clamp(), discVisibleFraction(), EARTH_SHADOW_RADIUS_ER, GL3, lunarEclipseLight(), NODES (+10 more)

### Community 68 - "geomag.js"
Cohesion: 0.11
Nodes (27): DEG2RAD, AURORA_KP, AURORA_PERIOD_S, AURORA_SETTINGS, auroraText(), boundaryLat(), COEF, computeAurora() (+19 more)

### Community 69 - "tz.js"
Cohesion: 0.16
Nodes (26): approxTzForLon(), canonMemo, canonTz(), daysInMonth(), deviceTz(), displayTz(), FALLBACK_ZONES, fromDatetimeLocal() (+18 more)

### Community 70 - "actions.js"
Cohesion: 0.07
Nodes (35): Shadow-axis point P = m − t·ŝ (shadowPoint), countryFor(), jumpToEvent(), playEclipse(), setEclipseFocus(), setObserver2(), ECLIPSE_FOV_DEG, ECLIPSE_LEAD_MS (+27 more)

### Community 71 - "Service Worker"
Cohesion: 0.46
Nodes (6): cacheable(), cacheFirst(), networkFirstShell(), PRECACHE, put(), staleWhileRevalidate()

### Community 72 - "setAttr"
Cohesion: 0.12
Nodes (27): openPopover(), close(), setAttr(), EXPOSE_PRESETS, exposeStatusText(), mountExpose(), openPop(), syncPill() (+19 more)

### Community 73 - "Debug Overlay"
Cohesion: 0.60
Nodes (4): createDebugOverlay(), drawSpark(), refresh(), formatCount()

### Community 74 - "camera.rig.test.mjs"
Cohesion: 0.11
Nodes (13): checkFrame(), FakeCanvas, HCMC, LUXOR, makeApp(), makeRig(), near(), PARIS (+5 more)

### Community 75 - "astro/totality.js"
Cohesion: 0.08
Nodes (44): sunHandover(), bailysBeads(), chromosphereFlash(), coronaFlattening(), coronaParams(), coronaStretch(), coronaVisibility(), createBeads() (+36 more)

### Community 76 - "stepToOrbit"
Cohesion: 0.16
Nodes (37): basisQuat(), advance(), applyMapCamera(), applySkyCamera(), applyVantagePose(), cancelTween(), cutVantageHome(), finishTween() (+29 more)

### Community 77 - "horizon.js"
Cohesion: 0.12
Nodes (23): refractionDeg(), buildHorizon(), building(), clamp(), clearanceDeg(), FAR_RIDGE_MAX_DEG, HORIZON_SAMPLES, horizonKey() (+15 more)

### Community 78 - "createPlanets"
Cohesion: 0.33
Nodes (9): eqAngRadius(), scopeBlend(), createPlanets(), syncFootprints(), tintFor(), update(), updateScope(), medallionFootprint() (+1 more)

### Community 79 - "clamp"
Cohesion: 0.16
Nodes (27): clamp(), altCeil(), anchoredLook(), applyBlend(), camRay(), centerAtNow(), clampMapTargets(), endTrack() (+19 more)

### Community 80 - "app.eclipse-chase.test.mjs"
Cohesion: 0.19
Nodes (19): CHASE_DURATION_S, CHASE_HOLD_MS, CHASE_OVERVIEW_DIST, CHASE_POSE, chaseLegs(), chaseTarget(), createEclipseChase(), end() (+11 more)

### Community 81 - "aim.js"
Cohesion: 0.16
Nodes (22): AIM_IDLE_MS, AIM_TAU_MOVING_MS, AIM_TAU_STILL_MS, aimFilterStep(), clamp(), createAim(), onOrientation(), requestLock() (+14 more)

### Community 82 - "postcard.js"
Cohesion: 0.16
Nodes (22): EXPOSE_KINDS, caption(), captureScale(), cardWords(), drawCaption(), drawMark(), drawNight(), layoutBand() (+14 more)

### Community 83 - "sky-guide.js"
Cohesion: 0.15
Nodes (22): _a, _b, BRIGHT_STARS, clamp(), COMPASS16_WORDS, compassWords16(), DIR8, findIt() (+14 more)

### Community 84 - "astro/bodies.js"
Cohesion: 0.14
Nodes (18): AU_KM, BODY_INDEX, EARTH_RADIUS_KM, createDiscFrame(), createDiscView(), MOON_LOG_K, RING_OUTER, SCOPE_FROM_PX (+10 more)

### Community 85 - "moons.js"
Cohesion: 0.15
Nodes (19): AE_KEYS, arcDeg(), bestLimbFeature(), computeGalilean(), crossing(), E, EDGE_CACHE, edgeRunFrom() (+11 more)

### Community 86 - "Planet Location Marker"
Cohesion: 0.11
Nodes (16): Accuracy, Credits and licences, Deploying, Features, How it is built, Keyboard shortcuts, [→ Open Planet Location Marker](https://anshler.github.io/planet-location-marker/), Planet Location Marker (+8 more)

### Community 87 - "render/totality.js"
Cohesion: 0.22
Nodes (12): SUN_INTENSITY, BEAD_FRAG, BEAD_VERT, BEAD_CORE, clamp(), createTotality(), apply(), applyTier() (+4 more)

### Community 88 - "trails.js"
Cohesion: 0.20
Nodes (16): glyphIntensity(), glyphSizePx(), createLineLayer(), makeLineGeometry(), createTrails(), apply(), clear(), dirAt() (+8 more)

### Community 89 - "planets.js"
Cohesion: 0.11
Nodes (22): MARS_SPOTS, SATURN_RINGS, _dir, EXTENT, GLOBE_K, MEDALLION_R, MEDALLION_SEL_R, MOON_R (+14 more)

### Community 90 - "createGovernor"
Cohesion: 0.27
Nodes (13): createGovernor(), budget(), cadenceMs(), config(), dprCanStep(), pin(), resetMeasure(), restartCadence() (+5 more)

### Community 91 - "createLabels"
Cohesion: 0.21
Nodes (18): Label anchors, priorities and UI occluders, ORBIT_LABEL_CAP, labelAnchor(), createLabels(), acquire(), applyAnchorToEl(), declutter(), makeEl() (+10 more)

### Community 92 - "Roadmap: v2.1 "breathtaking""
Cohesion: 0.15
Nodes (12): Dropped at review, How to continue, Log, Phase 0: Bug sweep & quick wins, Phase 1: Eclipse 2027, Phase 2: Sky view 2.0, Phase 3: Planets that are planets, Phase 4: Living Earth (+4 more)

### Community 93 - "flare.js"
Cohesion: 0.23
Nodes (13): sunAngularRadius(), limbTransmittance(), clamp(), createFlare(), apply(), dispose(), update(), discVisible() (+5 more)

### Community 94 - "ref_three"
Cohesion: 0.14
Nodes (15): FALLBACK_TIERS, createFinalPass(), createPostFx(), applySize(), build(), makeBloom(), makeFinal(), makeTarget() (+7 more)

### Community 95 - "render/eclipse-path.js"
Cohesion: 0.28
Nodes (12): ribbonMesh(), slerpUnit(), ANNULAR, createEclipsePath(), apply(), clear(), placeMarker(), show() (+4 more)

### Community 96 - "labels.js"
Cohesion: 0.24
Nodes (9): liftByRefraction(), azimuthDeg(), pickCandidates(), project(), EXTENTS, KIND_RANK, OCCLUDERS, rayHitsSphere() (+1 more)

### Community 97 - "createEyepiece"
Cohesion: 0.27
Nodes (14): compressRadius(), discFrame(), discView(), grsLongitudeDeg(), projectUp(), toFrame(), apply(), writeDiscInstance() (+6 more)

### Community 98 - "createBus"
Cohesion: 0.33
Nodes (8): BUS_EVENTS, createBus(), add(), clear(), off(), on(), once(), remove()

### Community 99 - "astro.skyglow.test.mjs"
Cohesion: 0.20
Nodes (4): col(), fullMoonNight(), json, PLACES

### Community 101 - "app.capture.test.mjs"
Cohesion: 0.12
Nodes (11): ANALEMMA_DAYS, ANALEMMA_S, analemmaPlan(), clamp(), DARK_SUN_DEG, EXPOSE_HIDDEN_LAYERS, meanNoonMs(), TRAILS_FOV_DEG (+3 more)

### Community 102 - "sampling.js"
Cohesion: 0.18
Nodes (19): createSupersampler(), fresh(), jitter(), halton(), SS_DRIFT_PX, SS_DRIFT_WEIGHT, SS_STILL_PX, SS_TWINKLE_WEIGHT (+11 more)

### Community 103 - "geo.mapview.test.mjs"
Cohesion: 0.20
Nodes (17): clamp(), clampMapCenter(), createMapFrame(), MAP_HALF_H, MAP_HALF_W, MAP_LIFT, MAP_SCALE, mapFitDistance() (+9 more)

### Community 104 - "setText"
Cohesion: 0.19
Nodes (19): setText(), fileStem(), ERRORS, mountVideo(), canShareFiles(), close(), download(), open() (+11 more)

### Community 105 - "capture.js"
Cohesion: 0.19
Nodes (16): createCapture(), drawLabels(), frame(), FONT_STACK, fontFor(), KIND_RANK, LABEL_STYLES, labelText() (+8 more)

### Community 106 - "ruler.js"
Cohesion: 0.27
Nodes (17): fmtAngle(), handSpan(), rulerText(), vectorAngleDeg(), COLOR, createRuler(), apply(), clear() (+9 more)

### Community 107 - "camera.system.test.mjs"
Cohesion: 0.14
Nodes (5): FakeCanvas, HCMC, makeRig(), snapAt(), T_OPP

### Community 108 - "edge-chips.js"
Cohesion: 0.30
Nodes (14): edgeHit(), chipMagLimit(), createEdgeChips(), cmp(), hideAll(), occluded(), occluder(), setVisible() (+6 more)

### Community 109 - "aurora.js"
Cohesion: 0.19
Nodes (12): auroraShellFor(), createAurora(), refresh(), createAuroraDriver(), createAuroraUniforms(), STEPS, STORM, STRENGTH (+4 more)

### Community 110 - "applyViewNow"
Cohesion: 0.22
Nodes (13): eclipticDir(), eclipticOf(), liftLat(), systemPose(), applyViewNow(), cancelSysTween(), enterSystem(), exitSystem() (+5 more)

### Community 111 - "common.glsl.js"
Cohesion: 0.38
Nodes (8): ATMO_MODEL, ATMOSPHERE_SHADER, AURORA_CHUNK, COMMON, SURFACE_FRAG, CLOUD_LOOKUP, MAP_FRAG, SURFACE_VERTEX

### Community 112 - "moonAppulses"
Cohesion: 0.30
Nodes (12): dailyDirections(), dirAt(), dirInterp(), geoSep(), localMinima(), minimize(), moonAppulses(), pairingEvent() (+4 more)

### Community 113 - "core.url-state.test.mjs"
Cohesion: 0.18
Nodes (6): DEFAULT_LAYER_CODE, LAYER_CODES, layersToCode(), ALLOWED_KEYS, BODY_IDS, LAYER_KEYS

### Community 114 - "fallback.js"
Cohesion: 0.33
Nodes (9): WebGL context-loss pause and restore, COPY, el(), ensureStyle(), hideContextLost(), showContextLost(), showFallback(), showFatal() (+1 more)

### Community 116 - "createTextureStore"
Cohesion: 0.42
Nodes (8): createTextureStore(), decode(), emit(), entryOf(), fetchBlob(), makeTexture(), progress(), startLoad()

### Community 117 - "astro.frames.test.mjs"
Cohesion: 0.25
Nodes (3): randomSkyCases(), rng(), iso()

### Community 118 - "vantageOwns"
Cohesion: 0.38
Nodes (7): applyRelease(), atGlobeMax(), sysZoom(), update(), updateSystemBlend(), vantageOwns(), zoom()

### Community 119 - "importRenderStack"
Cohesion: 0.38
Nodes (6): importRenderStack(), createLongExposure(), framingChanged(), release(), update(), GATE_SUN_DEG

## Knowledge Gaps
- **2 isolated node(s):** `./lazy.js`, `modulepreload/preload hints (three, astronomy-engine, main.js, cities.json)`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 888 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createRig()` connect `createRig` to `rig.js`, `labels.js`, `geo.mapview.test.mjs`, `stepToOrbit`, `applyViewNow`, `clamp`, `astro/orrery.js`, `vantageOwns`, `vantage.js`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Are the 43 inferred relationships involving `createActions()` (e.g. with `alignAim()` and `capture()`) actually correct?**
  _`createActions()` has 43 INFERRED edges - model-reasoned connections that need verification._
- **What connects `./lazy.js`, `modulepreload/preload hints (three, astronomy-engine, main.js, cities.json)` to the rest of the system?**
  _2 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `createRig` be split into smaller, more focused modules?**
  _Cohesion score 0.13213213213213212 - nodes in this community are weakly interconnected._
- **Why does `liftByRefraction()` connect `labels.js` to `rig.js`, `createRig`, `render/bodies.js`, `capture.js`, `ruler.js`, `astro/totality.js`, `edge-chips.js`, `horizon.js`, `ground.js`, `clamp`, `photometry.js`, `main.js`, `Snapshot & Eclipse Geometry`, `createLabels`, `flare.js`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Should `The astronomy behind Planet Location Marker (ASTRONOMY.md)` be split into smaller, more focused modules?**
  _Cohesion score 0.09487179487179487 - nodes in this community are weakly interconnected._
- **Why does `computeSnapshot()` connect `Snapshot & Eclipse Geometry` to `The astronomy behind Planet Location Marker (ASTRONOMY.md)`, `tours.js`, `Beams & Labels`, `App Actions API`, `Body Card & Sky Now`, `labels-feed.js`, `Frames & Moon Orientation`, `vantage.js`, `ref_node_test`, `astro/eclipse-path.js`, `Globe Picking`, `main.js`, `Frame Loop & Strikes`, `Retrograde Paths`, `recorder.js`, `Snapshot Detail Levels`, `Snapshot Tests`, `astro.shadow.test.mjs`, `geomag.js`, `actions.js`, `camera.rig.test.mjs`, `astro/totality.js`, `horizon.js`, `sky-guide.js`, `astro/bodies.js`, `moons.js`, `flare.js`, `astro.skyglow.test.mjs`, `app.capture.test.mjs`, `geo.mapview.test.mjs`, `camera.system.test.mjs`, `astro.frames.test.mjs`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._