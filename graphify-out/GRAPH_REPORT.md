# Graph Report - mars-location-marker  (2026-11-04)

## Corpus Check
- 168 files · ~330,356 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 7 file(s) not represented in the graph (top: (none) 5, .css 1, .webmanifest 1)

## Summary
- 2502 nodes · 6288 edges · 101 communities (99 shown, 2 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 323 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d6ff7e0c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- createRig
- The astronomy behind Planet Location Marker (ASTRONOMY.md)
- Formatting & Time Zones
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
- Labels Feed & Event Bus
- URL Hash State
- Render Context & PostFX
- Boot Sequence
- Milky Way Build
- Frames & Moon Orientation
- Snapshot & Eclipse Geometry
- check-size.mjs
- DOM Helpers & Help
- City Data Build
- data.catalog.test.mjs
- Vendor Pinning
- Sky Lines & Exposure
- Almanac & Verdicts
- Simulation Clock
- Quality Tiers & Governor
- Icon Generator
- earth.js
- Location Palette
- Cinematic Intro
- worker.js
- Observer Pin
- Loader & Failure Handling
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
- ref_node_assert
- Retrograde Paths
- ae.js
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
- Airmass & Visibility
- Debug Overlay
- camera.rig.test.mjs
- astro/totality.js
- stepToOrbit
- horizon.js
- planets.js
- clamp
- app.eclipse-chase.test.mjs
- createBodies
- eclipse-hud.js
- app.labels-feed.test.mjs
- astro/bodies.js
- moons.js
- Planet Location Marker
- render/totality.js
- trails.js
- planets.glsl.js
- createGovernor
- createLabels
- Roadmap: v2.1 "breathtaking"
- flare.js
- astro.eclipse-path.test.mjs
- render/eclipse-path.js
- labels.js
- createEyepiece
- createBus
- astro.skyglow.test.mjs
- three-hooks.mjs

## God Nodes (most connected - your core abstractions)
1. `createRig()` - 70 edges
2. `computeSnapshot()` - 57 edges
3. `createActions()` - 55 edges
4. `h()` - 54 edges
5. `boot()` - 47 edges
6. `mountTimebar()` - 44 edges
7. `The astronomy behind Planet Location Marker (ASTRONOMY.md)` - 44 edges
8. `setText()` - 35 edges
9. `icon()` - 35 edges
10. `createSnapshot()` - 34 edges

## Surprising Connections (you probably didn't know these)
- `Three-strikes module guard` --references--> `STRIKES_TO_DISABLE`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/loop.js
- `Text mode (no WebGL2 / no import maps fallback)` --references--> `showFallback()`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/fallback.js
- `WebGL context-loss pause and restore` --references--> `showContextLost()`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/fallback.js
- `Frame vs full snapshot detail (0.5 s staleness, 4 Hz readout)` --references--> `SNAP_STALE_MS`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/loop.js
- `Frame vs full snapshot detail (0.5 s staleness, 4 Hz readout)` --references--> `FULL_INTERVAL_MS`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/loop.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Earth orientation pipeline (GAST + precession/nutation through S)** — docs_astronomy_gast, docs_astronomy_iau2006_precession, docs_astronomy_iau2000b_nutation, docs_astronomy_s_mapping, docs_astronomy_earth_matrix, docs_astronomy_earth_fixed_frame, docs_astronomy_static_sky [EXTRACTED 1.00]
- **Hard repo rules R1–R7 enforced by tests** — docs_architecture_rule_pure_modules, docs_architecture_rule_three_confinement, docs_architecture_rule_ui_isolation, docs_architecture_rule_relative_urls, docs_architecture_rule_no_per_frame_allocation, docs_architecture_rule_shader_tonemapping, docs_architecture_rule_vector_conventions [EXTRACTED 1.00]
- **Boot-time failure and text-mode fallback chain** — index_global_error_capture, index_pcloader, index_pcenv, docs_architecture_text_mode, js_app_fallback, js_main_entertextmode, docs_architecture_failure_matrix [INFERRED 0.85]
- **Boot-time failure and text-mode fallback chain** — index_pcenv, index_global_error_capture, index_inline_loader, index_pcloader, docs_architecture_text_mode, docs_architecture_failure_matrix, docs_architecture_dynamic_import_split [INFERRED 0.85]

## Communities (101 total, 2 thin omitted)

### Community 0 - "createRig"
Cohesion: 0.16
Nodes (28): createRig(), afterTransition(), applyViewNow(), cancelTween(), centerAtNow(), defaultLook(), emitInteract(), flyToDirNow() (+20 more)

### Community 1 - "The astronomy behind Planet Location Marker (ASTRONOMY.md)"
Cohesion: 0.12
Nodes (28): Globe <-> sky transition (skyBlend, groundCover, descent pitch-up), The astronomy behind Planet Location Marker (ASTRONOMY.md), Accuracy budget, IAU WGCCRE rotational elements (Archinal et al. 2018), Ballesteros (2012) black-body colours, Disc-overlap eclipse model (discVisible), Earth-fixed frame (EF), earthMatrix = S·(PN·Rz(GAST))·Sᵀ (+20 more)

### Community 2 - "Formatting & Time Zones"
Cohesion: 0.14
Nodes (35): compass16, COMPASS8_WORDS, compassWord(), dms(), fmtAlt(), fmtAngSize(), fmtAz(), fmtDate() (+27 more)

### Community 3 - "render/bodies.js"
Cohesion: 0.13
Nodes (19): ATM_BETA_R, DISC_BLENDING, EXT_K, FALLBACK_MAG, MOON_MAP_GAIN, SUN_CORE, SUN_CORONA, SUN_GLOW (+11 more)

### Community 4 - "Beams & Labels"
Cohesion: 0.09
Nodes (38): Label anchors, priorities and UI occluders, ORBIT_LABEL_CAP, shadowAxisPoint(), umbraNear(), buildStrip(), createBeams(), apply(), boxAt() (+30 more)

### Community 5 - "Events & Trails"
Cohesion: 0.09
Nodes (57): Events search (quarters, oppositions, elongations, eclipses, seasons), appulseEvent(), cap(), centralDurS(), centralPhaseUp(), clockFormatter(), clockFormatters, constellationOf() (+49 more)

### Community 6 - "UI Hub & Shortcuts"
Cohesion: 0.07
Nodes (50): mountAnnouncer(), flush(), say(), createEmitter(), prefersReducedMotion(), COMPASS16, COMPASS_WORDS, createUiHub() (+42 more)

### Community 7 - "Time Bar & Scrubber"
Cohesion: 0.07
Nodes (58): clamp(), openPopover(), buildLut(), C_ASTRO, C_CIVIL, C_DAY, C_NAUT, C_NIGHT (+50 more)

### Community 8 - "Headless Smoke Harness"
Cohesion: 0.06
Nodes (49): build(), checkDerived(), imageSize(), isCachedSource(), main(), readLockFile(), readOrNull(), ROOT (+41 more)

### Community 9 - "App Actions API"
Cohesion: 0.08
Nodes (38): clamp(), createActions(), aimAtEvent(), bodyNow(), camDistance(), copyText(), cycleTracking(), cycleView() (+30 more)

### Community 10 - "Body Card & Sky Now"
Cohesion: 0.15
Nodes (33): angSize(), drawPhaseDisc(), EQUIPMENT, hexRgb(), KIND_LABEL, mixRgb(), mountBodyCard(), renderRts() (+25 more)

### Community 11 - "Shell, Icons & About"
Cohesion: 0.08
Nodes (44): CREDITS, mountAbout(), actionBtn(), kbd(), on(), close(), svgNS(), trapFocus() (+36 more)

### Community 12 - "repo.purity.test.mjs"
Cohesion: 0.13
Nodes (17): blank(), findImports(), KEYWORDS_BEFORE_REGEX, lineAt(), PUNCT_BEFORE_REGEX, scanJs(), ALLOWED_FILES, files() (+9 more)

### Community 13 - "Labels Feed & Event Bus"
Cohesion: 0.15
Nodes (22): bodyAnchors(), bodyLabelOffsets(), buildAnchors(), cardinalAnchors(), CARDINALS, clamp(), constellationAnchors(), sync() (+14 more)

### Community 14 - "URL Hash State"
Cohesion: 0.10
Nodes (37): URL hash format (loc, t, r, sel, ly, cam, q), bindUrl(), schedule(), write(), BODY_IDS, CAM, camToCode(), clamp() (+29 more)

### Community 15 - "Render Context & PostFX"
Cohesion: 0.10
Nodes (32): Development, createRenderContext(), chainCfg(), compile(), dispose(), ensurePostFx(), invalidate(), measure() (+24 more)

### Community 16 - "Boot Sequence"
Cohesion: 0.13
Nodes (20): Boot sequence (10 steps), Observer fallback chain (hash -> prefs -> largest city in device tz -> Greenwich), eclipseFocusExpired(), placeToObserver(), createLruCache(), applyHash(), bindMedia(), bindPreferences() (+12 more)

### Community 17 - "Milky Way Build"
Cohesion: 0.09
Nodes (38): addSpan(), blur(), buildEdges(), distanceField(), dt1d(), fillLevel(), gaussianKernel(), H (+30 more)

### Community 18 - "Frames & Moon Orientation"
Cohesion: 0.09
Nodes (14): EQJ frame (J2000 mean equator and equinox), S mapping EQJ -> scene ((x,y,z) -> (x,z,-y)), Scene frame (+Y = J2000 pole, 1 unit = Earth radius), COS_OBL, dirToAltAz(), dot3(), earthFixedToEqj(), eqjToScene() (+6 more)

### Community 19 - "Snapshot & Eclipse Geometry"
Cohesion: 0.07
Nodes (37): Light-time correction, Topocentric directions (Moon parallax ~1°), LIGHT_S_PER_AU, angleBetween3(), m3ToSceneM4(), m4MulDirT(), m4ToQuat(), createGalilean() (+29 more)

### Community 20 - "check-size.mjs"
Cohesion: 0.07
Nodes (38): DERIVED_LOCK, RECIPES, FALLBACK_ASSETS, FALLBACK_TIERS, FILE_BUDGETS, fmt(), INFO_TIERS, INTERIM (+30 more)

### Community 21 - "DOM Helpers & Help"
Cohesion: 0.13
Nodes (16): ovalSummary(), instances, append(), applyAttrs(), BOOL_ATTRS, FOCUSABLE, focusables(), kebab() (+8 more)

### Community 22 - "City Data Build"
Cohesion: 0.11
Nodes (25): buildCities(), byPopDesc(), CACHE, ensureSources(), FIELDS, main(), normaliseZones(), OUT (+17 more)

### Community 24 - "Vendor Pinning"
Cohesion: 0.14
Nodes (22): addon(), AE, checkEntry(), D3C, DERIVED_LOCK, listFiles(), LOCK, main() (+14 more)

### Community 25 - "Sky Lines & Exposure"
Cohesion: 0.09
Nodes (28): ZL_S10, GROUND_FRAG, GROUND_VERT, LANDSCAPE_CHUNK, SEA_CHUNK, SKY_PATCHES, TWILIGHT_CHUNK, EXTINCTION_CHUNK (+20 more)

### Community 26 - "Almanac & Verdicts"
Cohesion: 0.12
Nodes (35): aeObserverOf(), attempt(), classifySamples(), COMPASS, compass16(), DAYTIME_CAPABLE, decideVerdict(), equipmentFor() (+27 more)

### Community 27 - "Simulation Clock"
Cohesion: 0.24
Nodes (24): clamp01(), clampT(), createClock(), advanceRange(), clampStop(), effRate(), endRange(), flush() (+16 more)

### Community 28 - "Quality Tiers & Governor"
Cohesion: 0.16
Nodes (19): Quality tiers (low / medium / high), ALL_TIERS, autoStartTier(), CADENCE_PROBE_TICKS, CADENCE_STALE_MS, deepFreeze(), detectTier(), isAutoTier() (+11 more)

### Community 29 - "Icon Generator"
Cohesion: 0.14
Nodes (20): compilePaint(), compileShape(), design(), DIR, EARTH, ellipseDistance(), fmt(), hexRgb() (+12 more)

### Community 30 - "earth.js"
Cohesion: 0.07
Nodes (52): auroraShellFor(), createAurora(), refresh(), createAuroraDriver(), createAuroraUniforms(), STEPS, STORM, STRENGTH (+44 more)

### Community 31 - "Location Palette"
Cohesion: 0.21
Nodes (22): debounce(), h(), uid(), EXAMPLES, fold(), highlight(), mountLocation(), choose() (+14 more)

### Community 32 - "Cinematic Intro"
Cohesion: 0.22
Nodes (19): easeInOutCubic(), easeOutQuart(), INTRO_TIMING, introStartDir(), mulDir(), mulDirT(), normalize(), playIntro() (+11 more)

### Community 33 - "worker.js"
Cohesion: 0.22
Nodes (10): BODY_IDS, handleMessage(), OPS, riseSetAll(), runOp(), serializeError(), transferablesOf(), DAY_START (+2 more)

### Community 34 - "Observer Pin"
Cohesion: 0.19
Nodes (18): enuLocal(), latLonToLocal(), ACCENT, createPin(), apply(), dropPin(), setObserver(), settleDrop() (+10 more)

### Community 35 - "Loader & Failure Handling"
Cohesion: 0.20
Nodes (14): Body classes (is-ready, is-sky, tier-*, no-webgl, is-intro), index.html (entry page), Inline critical CSS (loader, no-webgl, is-intro body classes), fatal(), Inline loader screen (#loader, progress bar, rotating tips), modulepreload/preload hints (three, astronomy-engine, main.js, cities.json), nomodule unsupported-browser fallback, window.__pcEnv feature detection (importmap, webgl2, renderer, maxTex) (+6 more)

### Community 36 - "Offline Cities"
Cohesion: 0.14
Nodes (12): ALIASES, boundedDistance(), DEFAULT_FIELDS, placeLabel(), QUALIFIER_ALIASES, rowA, rowB, rowC (+4 more)

### Community 37 - "astro/eclipse-path.js"
Cohesion: 0.08
Nodes (39): eclipsePathFor(), SUN_RADIUS_KM, aeTime(), axisHit(), axisW, bisectEdge(), cA, cB (+31 more)

### Community 38 - "Preferences Storage"
Cohesion: 0.25
Nodes (15): clearAll(), isPlainObject(), kindOf(), load(), memory, persistent(), PREF_KEYS, PREFIX (+7 more)

### Community 39 - "Online Geocoder"
Cohesion: 0.22
Nodes (14): createGeocoder(), query(), search(), setStatus(), finite(), makePlace(), nominatim, openMeteo (+6 more)

### Community 40 - "Star Catalogue Build"
Cohesion: 0.16
Nodes (15): CI workflow (ci.yml), Generated-data freshness check (build-sky / build-milkyway --check), Deploy to GitHub Pages workflow (pages.yml), buildCons(), buildNames(), buildSky(), buildStars(), main() (+7 more)

### Community 41 - "Clock Rates & Limits"
Cohesion: 0.16
Nodes (14): BIT, easeRange(), EVENT_ORDER, logEase(), MAX_MS, MAX_RATE, MIN_MS, nextRate() (+6 more)

### Community 42 - "Sky Module"
Cohesion: 0.15
Nodes (17): raDecToScene(), altAzLocal(), createSky(), apply(), applyMagLimit(), buildStaticLines(), dispose(), refreshDetail() (+9 more)

### Community 43 - "Package Scripts"
Cohesion: 0.11
Nodes (17): name, private, scripts, data, icons, size, smoke, smoke:mobile (+9 more)

### Community 44 - "Static Dev Server"
Cohesion: 0.11
Nodes (16): Per-tier transfer budgets (3.8 / 4.3 / 5.4 MB, 12 MB deploy), STAGING_BUDGET, TIER_BUDGETS, createStaticServer(), MIME, mimeFor(), normalisePrefix(), resolveRequest() (+8 more)

### Community 45 - "Geocoder Tests"
Cohesion: 0.15
Nodes (8): PROVIDERS, EMPTY, fakeFetch(), hostOf(), NOMINATIM, ok(), OPEN_METEO, PHOTON

### Community 46 - "ground.js"
Cohesion: 0.21
Nodes (23): liftByRefraction(), createHorizonGlow(), umbraHorizonGlow(), urbanIndex(), extinctionRGB(), clamp(), createGround(), apply() (+15 more)

### Community 47 - "Globe Picking"
Cohesion: 0.21
Nodes (13): localToLatLon(), raySphere(), _d, _l, _ll, ndcXY(), _o, pickDir() (+5 more)

### Community 48 - "photometry.js"
Cohesion: 0.14
Nodes (23): adaptingLuminance(), buildBvLut(), bvToKelvin(), bvToRgb(), cieX(), cieY(), cieZ(), clamp01() (+15 more)

### Community 49 - "Coordinate Parsing"
Cohesion: 0.25
Nodes (11): decimalCommas(), fromHemisphereGroups(), groupByHemisphere(), groupPlain(), groupValue(), normalise(), parseLatLon(), tokenize() (+3 more)

### Community 50 - "main.js"
Cohesion: 0.11
Nodes (35): selectionLook(), viewModeLook(), COPY, el(), ensureStyle(), hideContextLost(), showContextLost(), showFallback() (+27 more)

### Community 51 - "Frame Loop & Strikes"
Cohesion: 0.24
Nodes (14): createLoop(), broadcast(), callModule(), disable(), feedCadence(), fillSkyglow(), frame(), nameOf() (+6 more)

### Community 52 - "State Store"
Cohesion: 0.18
Nodes (14): AURORA_SETTINGS, createStore(), deliver(), notify(), sourceFor(), deepFreeze(), DEFAULT_STATE, freezeShallow() (+6 more)

### Community 53 - "ref_node_assert"
Cohesion: 0.05
Nodes (21): HORIZON_SAMPLES, MANIFEST, randomSkyCases(), rng(), FILES, ROOT, iso(), SKY (+13 more)

### Community 54 - "Retrograde Paths"
Cohesion: 0.21
Nodes (15): Retrograde paths and stationary points, wrap180(), apparentPath(), bisectStation(), eclLonAt(), geoVector(), GHOST_DAYS, interpolatedDir() (+7 more)

### Community 55 - "ae.js"
Cohesion: 0.22
Nodes (5): AE, BODIES, GREENWICH, HANOI, TROMSO

### Community 56 - "Worker Client"
Cohesion: 0.31
Nodes (12): abortError(), createAstroClient(), call(), dispose(), eclipsePath(), ensureWorker(), onMessage(), pump() (+4 more)

### Community 57 - "astro/skyglow.js"
Cohesion: 0.09
Nodes (34): limitingMag(), BORTLE_SQM, BORTLE_SQM_MIN, bortleFromSqm(), cityCoreGlow(), cityRadiusKm(), computeSkyglow(), createSite() (+26 more)

### Community 58 - "Layout Shell"
Cohesion: 0.41
Nodes (12): mountShell(), applyLayout(), computeLayout(), measureSheet(), measureTimebar(), openPanel(), placeInk(), selectTab() (+4 more)

### Community 59 - "Event Search Tests"
Cohesion: 0.13
Nodes (12): upcomingEvents(), eclipseAt(), from2024, from2026, fromJune2027, HANOI, hanoi2024, hanoi2026 (+4 more)

### Community 60 - "Shader Domain Test"
Cohesion: 0.24
Nodes (10): firstArgs(), KNOWN_CLAMPED_TRIG_ARGS, KNOWN_POSITIVE_BASES, KNOWN_SAFE_LOG_ARGS, ourGlsl(), read(), ROOT, SHADER_DIR (+2 more)

### Community 61 - "Planet Location Marker architecture (ARCHITECTURE.md)"
Cohesion: 0.13
Nodes (17): Architecture, graphify, What this is, Planet Location Marker architecture (ARCHITECTURE.md), WebGL context-loss pause and restore, Failure handling matrix, RenderModule contract (object3d, apply, update, setLayers, setViewMode, setSelection, setQuality, dispose), Fixed render order (SPEC §E.1) (+9 more)

### Community 62 - "Snapshot Detail Levels"
Cohesion: 0.13
Nodes (16): Frame vs full snapshot detail (0.5 s staleness, 4 Hz readout), State and data flow (UI -> actions -> store -> render modules; clock -> loop), FEATURE_NAMES, FINE_FOV_DEG, FULL_INTERVAL_MS, MAX_DT_MS, OPT_FRAME, OPT_FULL (+8 more)

### Community 63 - "Snapshot Tests"
Cohesion: 0.15
Nodes (5): AU_ER, CONTACT_CASES, FULL, HONOLULU, numbersIn()

### Community 64 - "rig.js"
Cohesion: 0.05
Nodes (35): _bF, _bR, _bU, DESCENT_BLEND, DESCENT_PITCH, DESCENT_TURN, _fF, _fG (+27 more)

### Community 65 - "City Search Matching"
Cohesion: 0.42
Nodes (9): foldText(), loadCities(), aliasTargets(), fuzzyDistance(), nearest(), qualifies(), search(), tierOf() (+1 more)

### Community 66 - "eyepiece.js"
Cohesion: 0.09
Nodes (29): ringAt(), librationDirection(), ALB, albedo(), band(), C_BELT, C_GRS, C_POLE (+21 more)

### Community 67 - "astro.shadow.test.mjs"
Cohesion: 0.13
Nodes (20): EARTH_RADIUS_KM, MOON_RADIUS_ER, SUN_ANG_RADIUS_1AU_RAD, clamp(), discVisibleFraction(), EARTH_SHADOW_RADIUS_ER, GL3, lunarEclipseLight() (+12 more)

### Community 68 - "geomag.js"
Cohesion: 0.12
Nodes (27): m4MulDir(), AURORA_KP, AURORA_PERIOD_S, AURORA_SETTINGS, auroraText(), boundaryLat(), COEF, computeAurora() (+19 more)

### Community 69 - "tz.js"
Cohesion: 0.16
Nodes (26): approxTzForLon(), canonMemo, canonTz(), daysInMonth(), deviceTz(), displayTz(), FALLBACK_ZONES, fromDatetimeLocal() (+18 more)

### Community 70 - "actions.js"
Cohesion: 0.10
Nodes (27): Shadow-axis point P = m − t·ŝ (shadowPoint), countryFor(), telescope(), ECLIPSE_FOV_DEG, ECLIPSE_LEAD_MS, ECLIPSE_PLAY_MARGIN_MS, ECLIPSE_PLAY_S, LAYER_LABELS (+19 more)

### Community 71 - "Service Worker"
Cohesion: 0.46
Nodes (6): cacheable(), cacheFirst(), networkFirstShell(), PRECACHE, put(), staleWhileRevalidate()

### Community 72 - "Airmass & Visibility"
Cohesion: 0.43
Nodes (7): Airmass and extinction (Kasten–Young, k = 0.2 mag), Kasten & Young (1989) air mass, Tonight visibility verdicts, Twilight classes by solar altitude, airmass(), extinctionMag(), twilightClass()

### Community 73 - "Debug Overlay"
Cohesion: 0.38
Nodes (6): setDebug(), toggleDebug(), createDebugOverlay(), drawSpark(), refresh(), formatCount()

### Community 74 - "camera.rig.test.mjs"
Cohesion: 0.10
Nodes (13): checkFrame(), FakeCanvas, HCMC, LUXOR, makeApp(), makeRig(), near(), PARIS (+5 more)

### Community 75 - "astro/totality.js"
Cohesion: 0.12
Nodes (23): DEG2RAD, bailysBeads(), coronaFlattening(), coronaParams(), createCoronaParams(), CYCLE_MAX_MS, GLOW_EDGE_KM, GLOW_W (+15 more)

### Community 76 - "stepToOrbit"
Cohesion: 0.19
Nodes (26): basisQuat(), advance(), applyInsets(), applyRelease(), applySkyCamera(), finishTween(), followPose(), headingOf() (+18 more)

### Community 77 - "horizon.js"
Cohesion: 0.17
Nodes (19): buildHorizon(), building(), clamp(), FAR_RIDGE_MAX_DEG, horizonKey(), horizonSeed(), NEAR_BAND_MAX_DEG, periodicFbm() (+11 more)

### Community 78 - "planets.js"
Cohesion: 0.14
Nodes (20): createDiscFrame(), eqAngRadius(), scopeBlend(), createPlanets(), syncFootprints(), tintFor(), update(), updateScope() (+12 more)

### Community 79 - "clamp"
Cohesion: 0.19
Nodes (22): clamp(), altCeil(), anchoredLook(), applyBlend(), camRay(), endTrack(), lookFromForward(), nudge() (+14 more)

### Community 80 - "app.eclipse-chase.test.mjs"
Cohesion: 0.21
Nodes (18): CHASE_DURATION_S, CHASE_HOLD_MS, CHASE_OVERVIEW_DIST, CHASE_POSE, chaseLegs(), chaseTarget(), createEclipseChase(), end() (+10 more)

### Community 81 - "createBodies"
Cohesion: 0.19
Nodes (19): refractionDeg(), chromosphereFlash(), coronaStretch(), coronaVisibility(), clamp(), createBodies(), apply(), bindMoon() (+11 more)

### Community 82 - "eclipse-hud.js"
Cohesion: 0.20
Nodes (18): eclipseContacts(), fmtCountdown(), HUD_LEAD_MS, HUD_TRAIL_MS, hudCountdown(), isCentral(), build(), resolve() (+10 more)

### Community 83 - "app.labels-feed.test.mjs"
Cohesion: 0.13
Nodes (15): createLabelsFeed(), beamPointFn(), rebuild(), syncNames(), gateConstellationName(), gateStarName(), createHorizon(), anchors() (+7 more)

### Community 84 - "astro/bodies.js"
Cohesion: 0.16
Nodes (15): AU_KM, BODY_INDEX, createDiscView(), MARS_SPOTS, MOON_LOG_K, projectUp(), RING_OUTER, SCOPE_FROM_PX (+7 more)

### Community 85 - "moons.js"
Cohesion: 0.16
Nodes (17): AE_KEYS, arcDeg(), bestLimbFeature(), computeGalilean(), crossing(), E, EDGE_CACHE, edgeRunFrom() (+9 more)

### Community 86 - "Planet Location Marker"
Cohesion: 0.11
Nodes (16): Accuracy, Credits and licences, Deploying, Features, How it is built, Keyboard shortcuts, [→ Open Planet Location Marker](https://anshler.github.io/planet-location-marker/), Planet Location Marker (+8 more)

### Community 87 - "render/totality.js"
Cohesion: 0.18
Nodes (15): MAX_BEADS, photosphereAdapt(), SUN_INTENSITY, INFINITY_VERT_CHUNK, BEAD_FRAG, BEAD_VERT, BEAD_CORE, clamp() (+7 more)

### Community 88 - "trails.js"
Cohesion: 0.21
Nodes (15): glyphIntensity(), glyphSizePx(), createLineLayer(), createTrails(), apply(), clear(), dirAt(), dispose() (+7 more)

### Community 89 - "planets.glsl.js"
Cohesion: 0.17
Nodes (11): SATURN_RINGS, f(), MARS_GLSL, MARS_K, MEDALLION_FRAG, MEDALLION_VERT, PLANET_CHUNK, PLANET_KIND (+3 more)

### Community 90 - "createGovernor"
Cohesion: 0.27
Nodes (13): createGovernor(), budget(), cadenceMs(), config(), dprCanStep(), pin(), resetMeasure(), restartCadence() (+5 more)

### Community 91 - "createLabels"
Cohesion: 0.27
Nodes (15): createLabels(), acquire(), applyAnchorToEl(), declutter(), makeEl(), measure(), refreshOccluders(), relayout() (+7 more)

### Community 92 - "Roadmap: v2.1 "breathtaking""
Cohesion: 0.15
Nodes (12): Dropped at review, How to continue, Log, Phase 0: Bug sweep & quick wins, Phase 1: Eclipse 2027, Phase 2: Sky view 2.0, Phase 3: Planets that are planets, Phase 4: Living Earth (+4 more)

### Community 93 - "flare.js"
Cohesion: 0.28
Nodes (11): sunAngularRadius(), limbTransmittance(), clamp(), createFlare(), apply(), dispose(), update(), discVisible() (+3 more)

### Community 94 - "astro.eclipse-path.test.mjs"
Cohesion: 0.17
Nodes (10): PATH_COL, PATH_STRIDE, UMBRA_NEAR_RAD, apr2023, aug2026, aug2027, checkShape(), col() (+2 more)

### Community 95 - "render/eclipse-path.js"
Cohesion: 0.28
Nodes (12): ribbonMesh(), slerpUnit(), ANNULAR, createEclipsePath(), apply(), clear(), placeMarker(), show() (+4 more)

### Community 96 - "labels.js"
Cohesion: 0.23
Nodes (10): azimuthDeg(), clearanceDeg(), horizonAltDeg(), pickCandidates(), project(), EXTENTS, KIND_RANK, OCCLUDERS (+2 more)

### Community 97 - "createEyepiece"
Cohesion: 0.38
Nodes (11): compressRadius(), discFrame(), discView(), grsLongitudeDeg(), toFrame(), apply(), writeDiscInstance(), writeJupiterMoons() (+3 more)

### Community 98 - "createBus"
Cohesion: 0.33
Nodes (8): BUS_EVENTS, createBus(), add(), clear(), off(), on(), once(), remove()

### Community 99 - "astro.skyglow.test.mjs"
Cohesion: 0.20
Nodes (4): col(), fullMoonNight(), json, PLACES

## Knowledge Gaps
- **2 isolated node(s):** `./lazy.js`, `modulepreload/preload hints (three, astronomy-engine, main.js, cities.json)`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 722 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createRig()` connect `createRig` to `rig.js`, `stepToOrbit`, `ground.js`, `clamp`?**
  _High betweenness centrality (0.043) - this node is a cross-community bridge._
- **Are the 29 inferred relationships involving `createActions()` (e.g. with `cycleTracking()` and `cycleView()`) actually correct?**
  _`createActions()` has 29 INFERRED edges - model-reasoned connections that need verification._
- **What connects `./lazy.js`, `modulepreload/preload hints (three, astronomy-engine, main.js, cities.json)` to the rest of the system?**
  _2 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `The astronomy behind Planet Location Marker (ASTRONOMY.md)` be split into smaller, more focused modules?**
  _Cohesion score 0.11742424242424243 - nodes in this community are weakly interconnected._
- **Why does `BODIES` connect `ae.js` to `Cinematic Intro`, `astro.shadow.test.mjs`, `Beams & Labels`, `render/bodies.js`, `actions.js`, `UI Hub & Shortcuts`, `Time Bar & Scrubber`, `Body Card & Sky Now`, `Shell, Icons & About`, `Labels Feed & Event Bus`, `ground.js`, `planets.js`, `main.js`, `Snapshot & Eclipse Geometry`, `astro/bodies.js`, `Almanac & Verdicts`, `earth.js`, `Snapshot Tests`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Should `Formatting & Time Zones` be split into smaller, more focused modules?**
  _Cohesion score 0.14114114114114115 - nodes in this community are weakly interconnected._
- **Why does `h()` connect `Location Palette` to `createEyepiece`, `eyepiece.js`, `UI Hub & Shortcuts`, `Time Bar & Scrubber`, `Body Card & Sky Now`, `Shell, Icons & About`, `Render Context & PostFX`, `eclipse-hud.js`, `DOM Helpers & Help`, `Layout Shell`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._