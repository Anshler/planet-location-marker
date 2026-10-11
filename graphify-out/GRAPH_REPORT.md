# Graph Report - mars-location-marker  (2026-10-11)

## Corpus Check
- 47 files · ~200,773 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1797 nodes · 4318 edges · 74 communities
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 330 edges (avg confidence: 0.86)
- Token cost: 140,485 input · 0 output

## Community Hubs (Navigation)
- Camera Rig & Transitions
- Docs & Design Concepts
- Formatting & Time Zones
- Bodies, Shadows & Flare
- Beams & Labels
- Events & Trails
- UI Hub & Shortcuts
- Time Bar & Scrubber
- Headless Smoke Harness
- App Actions API
- Body Card & Sky Now
- Shell, Icons & About
- Repo Hygiene Tests
- Labels Feed & Event Bus
- URL Hash State
- Render Context & PostFX
- Boot Sequence
- Milky Way Build
- Frames & Moon Orientation
- Snapshot & Eclipse Geometry
- Size Budget & Pages Staging
- DOM Helpers & Help
- City Data Build
- Astronomy Engine & Catalog Tests
- Vendor Pinning
- Sky Lines & Exposure
- Almanac & Verdicts
- Simulation Clock
- Quality Tiers & Governor
- Icon Generator
- Earth Textures by Tier
- Location Palette
- Cinematic Intro
- Astro Worker Ops
- Observer Pin
- Loader & Failure Handling
- Offline Cities
- PNG/ZIP Tooling
- Preferences Storage
- Online Geocoder
- Star Catalogue Build
- Clock Rates & Limits
- Sky Module
- Package Scripts
- Static Dev Server
- Geocoder Tests
- Sky-View Ground
- Globe Picking
- Photometry & Star Colour
- Coordinate Parsing
- Render Boot & State Binding
- Frame Loop & Strikes
- State Store
- Transition Margin Test
- Retrograde Paths
- Almanac & Worker Tests
- Worker Client
- Purity Rules Test
- Layout Shell
- Event Search Tests
- Shader Domain Test
- Fallback & Context Loss
- Snapshot Detail Levels
- Snapshot Tests
- URL State Tests
- City Search Matching
- Earth Module
- Atmosphere & Ground Cover
- Shared Shader Chunks
- Texture Store
- Frame Math Tests
- Service Worker
- Airmass & Visibility
- Debug Overlay

## God Nodes (most connected - your core abstractions)
1. `h()` - 49 edges
2. `createRig()` - 48 edges
3. `The astronomy behind Planet Location Marker (ASTRONOMY.md)` - 46 edges
4. `mountTimebar()` - 42 edges
5. `createActions()` - 31 edges
6. `Planet Location Marker architecture (ARCHITECTURE.md)` - 31 edges
7. `icon()` - 30 edges
8. `createUiHub()` - 30 edges
9. `boot()` - 30 edges
10. `createClock()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `S mapping EQJ -> scene ((x,y,z) -> (x,z,-y))` --references--> `eqjToScene()`  [INFERRED]
  docs/ASTRONOMY.md → js/astro/frames.js
- `S mapping EQJ -> scene ((x,y,z) -> (x,z,-y))` --references--> `S`  [INFERRED]
  docs/ASTRONOMY.md → js/astro/frames.js
- `window.__app debug API (ready, snapshot, stats)` --references--> `app`  [INFERRED]
  docs/ARCHITECTURE.md → js/main.js
- `Three-strikes module guard` --references--> `STRIKES_TO_DISABLE`  [INFERRED]
  docs/ARCHITECTURE.md → js/app/loop.js
- `createBeams()` --implements--> `RenderModule contract (object3d, apply, update, setLayers, setViewMode, setSelection, setQuality, dispose)`  [INFERRED]
  js/render/beams.js → docs/ARCHITECTURE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Hard repo rules R1–R7 enforced by tests** — docs_architecture_rule_pure_modules, docs_architecture_rule_three_confinement, docs_architecture_rule_ui_isolation, docs_architecture_rule_relative_urls, docs_architecture_rule_no_per_frame_allocation, docs_architecture_rule_shader_tonemapping, docs_architecture_rule_vector_conventions [EXTRACTED 1.00]
- **Boot-time failure and text-mode fallback chain** — index_global_error_capture, index_pcloader, index_pcenv, docs_architecture_text_mode, js_app_fallback, js_main_entertextmode, docs_architecture_failure_matrix [INFERRED 0.85]
- **Hard repo rules R1–R7 enforced by tests** — docs_architecture_rule_pure_modules, docs_architecture_rule_three_confinement, docs_architecture_rule_ui_isolation, docs_architecture_rule_relative_urls, docs_architecture_rule_no_per_frame_allocation, docs_architecture_rule_shader_tonemapping, docs_architecture_rule_vector_conventions, claude_hard_rules [EXTRACTED 1.00]
- **Boot-time failure and text-mode fallback chain** — index_pcenv, index_global_error_capture, index_inline_loader, index_pcloader, docs_architecture_text_mode, docs_architecture_failure_matrix, docs_architecture_dynamic_import_split [INFERRED 0.85]
- **Earth orientation pipeline (GAST + precession/nutation through S)** — docs_astronomy_gast, docs_astronomy_iau2006_precession, docs_astronomy_iau2000b_nutation, docs_astronomy_s_mapping, docs_astronomy_earth_matrix, docs_astronomy_earth_fixed_frame, docs_astronomy_static_sky [EXTRACTED 1.00]

## Communities (74 total, 0 thin omitted)

### Community 0 - "Camera Rig & Transitions"
Cohesion: 0.08
Nodes (68): basisQuat(), _bF, _bR, _bU, clamp(), createRig(), advance(), afterTransition() (+60 more)

### Community 1 - "Docs & Design Concepts"
Cohesion: 0.07
Nodes (54): CLAUDE.md (Claude Code guidance), graphify knowledge-graph workflow (query first, --update after changes), Planet Location Marker architecture (ARCHITECTURE.md), Globe <-> sky transition (skyBlend, groundCover, descent pitch-up), RenderModule contract (object3d, apply, update, setLayers, setViewMode, setSelection, setQuality, dispose), Fixed render order (SPEC §E.1), Headless Chrome smoke test (all external hosts blocked), window.__app debug API (ready, snapshot, stats) (+46 more)

### Community 2 - "Formatting & Time Zones"
Cohesion: 0.08
Nodes (61): COMPASS16, COMPASS8_WORDS, compassWord(), dms(), fmtAlt(), fmtAngSize(), fmtAz(), fmtDate() (+53 more)

### Community 3 - "Bodies, Shadows & Flare"
Cohesion: 0.06
Nodes (52): BODIES, EARTH_RADIUS_KM, MOON_RADIUS_ER, SUN_ANG_RADIUS_RAD, clamp(), discVisibleFraction(), EARTH_SHADOW_RADIUS_ER, GL3 (+44 more)

### Community 4 - "Beams & Labels"
Cohesion: 0.06
Nodes (54): Label anchors, priorities and UI occluders, ORBIT_LABEL_CAP, buildStrip(), createBeams(), apply(), boxAt(), computeAnchors(), labelAnchor() (+46 more)

### Community 5 - "Events & Trails"
Cohesion: 0.09
Nodes (51): Events search (quarters, oppositions, elongations, eclipses, seasons), bodyById(), appulseEvent(), cap(), constellationOf(), dailyDirections(), describeOpposition(), dirAt() (+43 more)

### Community 6 - "UI Hub & Shortcuts"
Cohesion: 0.07
Nodes (51): mountAnnouncer(), flush(), say(), createEmitter(), prefersReducedMotion(), COMPASS16, COMPASS_WORDS, createUiHub() (+43 more)

### Community 7 - "Time Bar & Scrubber"
Cohesion: 0.08
Nodes (50): clamp(), openPopover(), buildLut(), C_ASTRO, C_CIVIL, C_DAY, C_NAUT, C_NIGHT (+42 more)

### Community 8 - "Headless Smoke Harness"
Cohesion: 0.07
Nodes (38): CdpClient, findChrome(), launchChrome(), sleep(), acceptance(), args, argText(), ASSERT (+30 more)

### Community 9 - "App Actions API"
Cohesion: 0.08
Nodes (41): clamp(), countryFor(), createActions(), camDistance(), copyText(), cycleView(), flyToBody(), jumpToEvent() (+33 more)

### Community 10 - "Body Card & Sky Now"
Cohesion: 0.10
Nodes (40): AU_KM, BODY_INDEX, angSize(), drawPhaseDisc(), EQUIPMENT, hexRgb(), KIND_LABEL, mixRgb() (+32 more)

### Community 11 - "Shell, Icons & About"
Cohesion: 0.13
Nodes (30): CREDITS, mountAbout(), on(), s(), svgNS(), F, icon(), ICON_NAMES (+22 more)

### Community 12 - "Repo Hygiene Tests"
Cohesion: 0.10
Nodes (22): blank(), findImports(), KEYWORDS_BEFORE_REGEX, lineAt(), PUNCT_BEFORE_REGEX, scanJs(), crawlModules(), pageEntries() (+14 more)

### Community 13 - "Labels Feed & Event Bus"
Cohesion: 0.09
Nodes (31): bodyAnchors(), buildAnchors(), cardinalAnchors(), CARDINALS, clamp(), constellationAnchors(), createLabelsFeed(), beamPointFn() (+23 more)

### Community 14 - "URL Hash State"
Cohesion: 0.13
Nodes (33): URL hash format (loc, t, r, sel, ly, cam, q), snapRate(), bindUrl(), schedule(), write(), BODY_IDS, CAM, camToCode() (+25 more)

### Community 15 - "Render Context & PostFX"
Cohesion: 0.11
Nodes (27): createRenderContext(), compile(), dispose(), ensurePostFx(), invalidate(), measure(), presentIfCleared(), render() (+19 more)

### Community 16 - "Boot Sequence"
Cohesion: 0.12
Nodes (29): Boot sequence (10 steps), Observer fallback chain (hash -> prefs -> largest city in device tz -> Greenwich), app, applyHash(), bindMedia(), bindPreferences(), boot(), createCitiesProxy() (+21 more)

### Community 17 - "Milky Way Build"
Cohesion: 0.11
Nodes (27): addSpan(), blur(), buildEdges(), distanceField(), dt1d(), fillLevel(), gaussianKernel(), H (+19 more)

### Community 18 - "Frames & Moon Orientation"
Cohesion: 0.08
Nodes (16): IAU WGCCRE rotational elements (Archinal et al. 2018), True-scale Moon (IAU rotation, libration, Lommel–Seeliger lighting), COS_OBL, DEG2RAD, dirToAltAz(), dot3(), earthFixedToEqj(), earthRotationM3() (+8 more)

### Community 19 - "Snapshot & Eclipse Geometry"
Cohesion: 0.09
Nodes (28): Shadow-axis point P = m − t·ŝ (shadowPoint), Topocentric directions (Moon parallax ~1°), shadowPoint(), LIGHT_S_PER_AU, m3ToSceneM4(), m4MulDir(), m4MulDirT(), m4ToQuat() (+20 more)

### Community 20 - "Size Budget & Pages Staging"
Cohesion: 0.11
Nodes (25): Per-tier transfer budgets (3.8 / 4.3 / 5.4 MB, 12 MB deploy), CI workflow (ci.yml), Generated-data freshness check (build-sky / build-milkyway --check), Deploy to GitHub Pages workflow (pages.yml), FALLBACK_ASSETS, FALLBACK_TIERS, FILE_BUDGETS, fmt() (+17 more)

### Community 21 - "DOM Helpers & Help"
Cohesion: 0.13
Nodes (22): instances, append(), applyAttrs(), BOOL_ATTRS, FOCUSABLE, focusables(), h(), kbd() (+14 more)

### Community 22 - "City Data Build"
Cohesion: 0.12
Nodes (24): buildCities(), byPopDesc(), CACHE, ensureSources(), FIELDS, main(), normaliseZones(), OUT (+16 more)

### Community 23 - "Astronomy Engine & Catalog Tests"
Cohesion: 0.10
Nodes (7): AE, mars, marsStations, FILES, ROOT, cat, SKY

### Community 24 - "Vendor Pinning"
Cohesion: 0.12
Nodes (22): addon(), AE, checkEntry(), D3C, listFiles(), LOCK, main(), MANIFEST (+14 more)

### Community 25 - "Sky Lines & Exposure"
Cohesion: 0.12
Nodes (24): raDecToScene(), EXTINCTION_CHUNK, LINE_FRAG, LINE_VERT, MW_FRAG, MW_VERT, SMOOTH_FALL_CHUNK, STAR_FRAG (+16 more)

### Community 26 - "Almanac & Verdicts"
Cohesion: 0.13
Nodes (24): classifySamples(), COMPASS, compass16(), DAYTIME_CAPABLE, decideVerdict(), equipmentFor(), fmtMag(), GLARE_LIMIT_DEG (+16 more)

### Community 27 - "Simulation Clock"
Cohesion: 0.25
Nodes (23): clamp01(), clampT(), createClock(), advanceRange(), clampStop(), effRate(), endRange(), flush() (+15 more)

### Community 28 - "Quality Tiers & Governor"
Cohesion: 0.17
Nodes (18): Quality tiers (low / medium / high), createGovernor(), config(), pin(), resetMeasure(), sample(), setTier(), stepDown() (+10 more)

### Community 29 - "Icon Generator"
Cohesion: 0.14
Nodes (20): compilePaint(), compileShape(), design(), DIR, EARTH, ellipseDistance(), fmt(), hexRgb() (+12 more)

### Community 30 - "Earth Textures by Tier"
Cohesion: 0.13
Nodes (19): CLOUD_DRIFT_EPOCH_MS, DAY_GAIN, DERIVED_WINDOW, LOOK, nullStore(), resolveCfg(), TIER_DEFAULTS, ATMO_SUN_I (+11 more)

### Community 31 - "Location Palette"
Cohesion: 0.21
Nodes (20): uid(), EXAMPLES, fold(), highlight(), mountLocation(), choose(), cityModel(), dedupe() (+12 more)

### Community 32 - "Cinematic Intro"
Cohesion: 0.22
Nodes (19): easeInOutCubic(), easeOutQuart(), INTRO_TIMING, introStartDir(), mulDir(), mulDirT(), normalize(), playIntro() (+11 more)

### Community 33 - "Astro Worker Ops"
Cohesion: 0.23
Nodes (18): aeObserverOf(), attempt(), horizontal(), requireBody(), requireMs(), riseTransitSet(), statusWithoutCrossing(), sunAltitudeSeries() (+10 more)

### Community 34 - "Observer Pin"
Cohesion: 0.19
Nodes (17): enuLocal(), ACCENT, createPin(), apply(), dropPin(), setObserver(), settleDrop(), stepAnimation() (+9 more)

### Community 35 - "Loader & Failure Handling"
Cohesion: 0.19
Nodes (17): Body classes (is-ready, is-sky, tier-*, no-webgl, is-intro), Failure handling matrix, Text mode (no WebGL2 / no import maps fallback), index.html (entry page), Inline critical CSS (loader, no-webgl, is-intro body classes), fatal(), Global error capture (error / unhandledrejection before __pcBooted), Inline loader screen (#loader, progress bar, rotating tips) (+9 more)

### Community 36 - "Offline Cities"
Cohesion: 0.12
Nodes (15): ALIASES, boundedDistance(), DEFAULT_FIELDS, placeLabel(), placeToObserver(), QUALIFIER_ALIASES, rowA, rowB (+7 more)

### Community 37 - "PNG/ZIP Tooling"
Cohesion: 0.19
Nodes (15): CHANNELS_BY_COLOR_TYPE, chunk(), COLOR_TYPE_BY_CHANNELS, crc32(), CRC_TABLE, decodePng(), encodePng(), filterRow() (+7 more)

### Community 38 - "Preferences Storage"
Cohesion: 0.25
Nodes (15): clearAll(), isPlainObject(), kindOf(), load(), memory, persistent(), PREF_KEYS, PREFIX (+7 more)

### Community 39 - "Online Geocoder"
Cohesion: 0.23
Nodes (15): createGeocoder(), query(), search(), setStatus(), createLruCache(), finite(), makePlace(), nominatim (+7 more)

### Community 40 - "Star Catalogue Build"
Cohesion: 0.21
Nodes (14): buildCons(), buildNames(), buildSky(), buildStars(), main(), OUT, packPolyline(), packRa() (+6 more)

### Community 41 - "Clock Rates & Limits"
Cohesion: 0.19
Nodes (11): BIT, EVENT_ORDER, logEase(), MAX_MS, MAX_RATE, MIN_MS, nextRate(), RATES (+3 more)

### Community 42 - "Sky Module"
Cohesion: 0.21
Nodes (12): createSky(), apply(), applyMagLimit(), dispose(), refreshDetail(), setCatalog(), setHighlight(), setQuality() (+4 more)

### Community 43 - "Package Scripts"
Cohesion: 0.12
Nodes (15): name, private, scripts, data, icons, size, smoke, smoke:mobile (+7 more)

### Community 44 - "Static Dev Server"
Cohesion: 0.18
Nodes (11): npm scripts (start, test, smoke, size, vendor, data), createStaticServer(), MIME, mimeFor(), normalisePrefix(), resolveRequest(), statOrNull(), app (+3 more)

### Community 45 - "Geocoder Tests"
Cohesion: 0.15
Nodes (8): PROVIDERS, EMPTY, fakeFetch(), hostOf(), NOMINATIM, ok(), OPEN_METEO, PHOTON

### Community 46 - "Sky-View Ground"
Cohesion: 0.24
Nodes (13): clamp(), createGround(), apply(), dispose(), eclipseGains(), setViewMode(), update(), smooth() (+5 more)

### Community 47 - "Globe Picking"
Cohesion: 0.21
Nodes (13): localToLatLon(), raySphere(), _d, _l, _ll, ndcXY(), _o, pickDir() (+5 more)

### Community 48 - "Photometry & Star Colour"
Cohesion: 0.25
Nodes (12): buildBvLut(), bvToKelvin(), bvToRgb(), cieX(), cieY(), cieZ(), exposureFor(), kelvinToRgb() (+4 more)

### Community 49 - "Coordinate Parsing"
Cohesion: 0.25
Nodes (11): decimalCommas(), fromHemisphereGroups(), groupByHemisphere(), groupPlain(), groupValue(), normalise(), parseLatLon(), tokenize() (+3 more)

### Community 50 - "Render Boot & State Binding"
Cohesion: 0.20
Nodes (14): bindRenderState(), bindViewInsets(), bootRender(), delay(), handleSceneClick(), idle(), lookFor(), noop() (+6 more)

### Community 51 - "Frame Loop & Strikes"
Cohesion: 0.29
Nodes (10): createLoop(), broadcast(), callModule(), disable(), frame(), nameOf(), reportOnce(), resume() (+2 more)

### Community 52 - "State Store"
Cohesion: 0.28
Nodes (9): createStore(), deliver(), notify(), sourceFor(), deepFreeze(), DEFAULT_STATE, freezeShallow(), isPlainObject() (+1 more)

### Community 53 - "Transition Margin Test"
Cohesion: 0.15
Nodes (6): ALTS, ASPECTS, C, rig, ROOT, sky

### Community 54 - "Retrograde Paths"
Cohesion: 0.38
Nodes (11): Retrograde paths and stationary points, wrap180(), apparentPath(), bisectStation(), eclLonAt(), geoVector(), interpolatedDir(), interpolatedStation() (+3 more)

### Community 55 - "Almanac & Worker Tests"
Cohesion: 0.17
Nodes (7): BODY_IDS, GREENWICH, HANOI, TROMSO, DAY_START, HANOI, NEAR

### Community 56 - "Worker Client"
Cohesion: 0.33
Nodes (11): abortError(), createAstroClient(), call(), dispose(), ensureWorker(), onMessage(), pump(), runNext() (+3 more)

### Community 57 - "Purity Rules Test"
Cohesion: 0.20
Nodes (8): allApp, jsFiles(), PURE_DIRS, pureFiles, ROOT, source(), specifiers(), V1_LEFTOVERS

### Community 58 - "Layout Shell"
Cohesion: 0.42
Nodes (11): mountShell(), applyLayout(), computeLayout(), measureSheet(), measureTimebar(), openPanel(), placeInk(), selectTab() (+3 more)

### Community 59 - "Event Search Tests"
Cohesion: 0.18
Nodes (9): from2024, from2026, fromJune2027, HANOI, hanoi2024, hanoi2026, KINDS, MADRID (+1 more)

### Community 60 - "Shader Domain Test"
Cohesion: 0.24
Nodes (10): firstArgs(), KNOWN_CLAMPED_TRIG_ARGS, KNOWN_POSITIVE_BASES, KNOWN_SAFE_LOG_ARGS, ourGlsl(), read(), ROOT, SHADER_DIR (+2 more)

### Community 61 - "Fallback & Context Loss"
Cohesion: 0.33
Nodes (9): WebGL context-loss pause and restore, COPY, el(), ensureStyle(), hideContextLost(), showContextLost(), showFallback(), showFatal() (+1 more)

### Community 62 - "Snapshot Detail Levels"
Cohesion: 0.22
Nodes (9): Frame vs full snapshot detail (0.5 s staleness, 4 Hz readout), State and data flow (UI -> actions -> store -> render modules; clock -> loop), FEATURE_NAMES, FULL_INTERVAL_MS, MAX_DT_MS, OPT_FRAME, OPT_FULL, SNAP_STALE_MS (+1 more)

### Community 63 - "Snapshot Tests"
Cohesion: 0.20
Nodes (4): AU_ER, FULL, HONOLULU, numbersIn()

### Community 64 - "URL State Tests"
Cohesion: 0.20
Nodes (5): DEFAULT_LAYER_CODE, LAYER_CODES, ALLOWED_KEYS, BODY_IDS, LAYER_KEYS

### Community 65 - "City Search Matching"
Cohesion: 0.36
Nodes (10): foldText(), loadCities(), aliasTargets(), byTz(), fuzzyDistance(), nearest(), qualifies(), search() (+2 more)

### Community 66 - "Earth Module"
Cohesion: 0.33
Nodes (9): createEarth(), bindSlot(), bindTier(), clearSlot(), refreshClouds(), refreshVisibility(), want(), definesFor() (+1 more)

### Community 67 - "Atmosphere & Ground Cover"
Cohesion: 0.33
Nodes (8): createAtmosphere(), refresh(), definesFor(), modelOf(), SEGMENTS_BY_TIER, ATMO_EXPOSURE, ATMOSPHERE_SHADER, groundCover()

### Community 68 - "Shared Shader Chunks"
Cohesion: 0.56
Nodes (5): ATMO_MODEL, COMMON, SURFACE_FRAG, CLOUD_LOOKUP, SURFACE_VERTEX

### Community 69 - "Texture Store"
Cohesion: 0.42
Nodes (8): createTextureStore(), decode(), emit(), entryOf(), fetchBlob(), makeTexture(), progress(), startLoad()

### Community 70 - "Frame Math Tests"
Cohesion: 0.25
Nodes (3): randomSkyCases(), rng(), iso()

### Community 71 - "Service Worker"
Cohesion: 0.46
Nodes (6): cacheable(), cacheFirst(), networkFirstShell(), PRECACHE, put(), staleWhileRevalidate()

### Community 72 - "Airmass & Visibility"
Cohesion: 0.43
Nodes (7): Airmass and extinction (Kasten–Young, k = 0.2 mag), Kasten & Young (1989) air mass, Tonight visibility verdicts, Twilight classes by solar altitude, airmass(), extinctionMag(), twilightClass()

### Community 73 - "Debug Overlay"
Cohesion: 0.38
Nodes (6): setDebug(), toggleDebug(), createDebugOverlay(), drawSpark(), refresh(), formatCount()

## Knowledge Gaps
- **2 isolated node(s):** `./lazy.js`, `graphify knowledge-graph workflow (query first, --update after changes)`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 458 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `BODIES` connect `Bodies, Shadows & Flare` to `Cinematic Intro`, `Beams & Labels`, `UI Hub & Shortcuts`, `Time Bar & Scrubber`, `Body Card & Sky Now`, `Labels Feed & Event Bus`, `Boot Sequence`, `Snapshot & Eclipse Geometry`, `Almanac & Worker Tests`, `Almanac & Verdicts`, `Earth Textures by Tier`, `Snapshot Tests`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `mountTimebar()` (e.g. with `arrange()` and `openDate()`) actually correct?**
  _`mountTimebar()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `./lazy.js`, `graphify knowledge-graph workflow (query first, --update after changes)` to the rest of the system?**
  _2 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Camera Rig & Transitions` be split into smaller, more focused modules?**
  _Cohesion score 0.08215962441314555 - nodes in this community are weakly interconnected._
- **Why does `createClock()` connect `Simulation Clock` to `URL State Tests`, `Docs & Design Concepts`, `Clock Rates & Limits`, `Boot Sequence`, `Snapshot Detail Levels`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Should `Docs & Design Concepts` be split into smaller, more focused modules?**
  _Cohesion score 0.06521739130434782 - nodes in this community are weakly interconnected._
- **Should `Formatting & Time Zones` be split into smaller, more focused modules?**
  _Cohesion score 0.07553143374038897 - nodes in this community are weakly interconnected._