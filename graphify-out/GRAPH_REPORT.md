# Graph Report - mars-location-marker  (2026-11-05)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 4508 nodes · 12913 edges · 141 communities (140 shown, 1 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 477 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `04054d2a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- eyepiece.js
- mountTimebar
- ref_node_assert
- main.js
- Beams & Labels
- Events & Trails
- UI Hub & Shortcuts
- Time Bar & Scrubber
- Headless Smoke Harness
- App Actions API
- Body Card & Sky Now
- Shell, Icons & About
- snapshot.js
- astro/eclipse-path.js
- URL Hash State
- beams.js
- createRig
- Milky Way Build
- Frames & Moon Orientation
- Snapshot & Eclipse Geometry
- The astronomy behind Planet Location Marker (ASTRONOMY.md)
- dom.js
- City Data Build
- h
- Vendor Pinning
- Sky Lines & Exposure
- Almanac & Verdicts
- Simulation Clock
- Quality Tiers & Governor
- Icon Generator
- sky.js
- rig.js
- Cinematic Intro
- astro.precession.test.mjs
- build-milkyway.mjs
- check-size.mjs
- Offline Cities
- clamp
- Preferences Storage
- Online Geocoder
- Star Catalogue Build
- Clock Rates & Limits
- Sky Module
- Package Scripts
- Static Dev Server
- Geocoder Tests
- quality.js
- Globe Picking
- events.js
- Coordinate Parsing
- locale
- Frame Loop & Strikes
- State Store
- astro/comets.js
- Retrograde Paths
- flare.js
- Worker Client
- url-state.js
- Layout Shell
- Event Search Tests
- Shader Domain Test
- THIRD_PARTY_NOTICES.md
- Snapshot Detail Levels
- Snapshot Tests
- camera.mapview.test.mjs
- City Search Matching
- stage-site.mjs
- loop.js
- repo.tooling.test.mjs
- camera.rig.test.mjs
- createLoop
- Service Worker
- tooling.perf-gates.test.mjs
- Debug Overlay
- astro/extras.js
- core.url-state.test.mjs
- astro.dso.test.mjs
- push
- build-sky.mjs
- earthMatrix = S*(PN*Rz(GAST))*S^T
- createClock
- createSky
- sampling.js
- sw.js
- app.capture.test.mjs
- playIntro
- sky-guide.js
- horizon.js
- app.eclipse-chase.test.mjs
- photometry.js
- ui.ics.test.mjs
- scripts
- build-icons.mjs
- build-textures.mjs
- app.wake-lock.test.mjs
- app.tier-switch.test.mjs
- capture.js
- planner.js
- mars-sky.js
- createMeteors
- wrap360
- camera.system.test.mjs
- createSwClient
- ae.js
- picking.js
- liftByRefraction
- clock.js
- createTextureStore
- createStore
- BODIES
- msOf
- year-planner.js
- store.js
- edge-chips.js
- Roadmap: v2.1 "breathtaking"
- Architecture
- Features
- astro.events.test.mjs
- Night-sky brightness model (computeSkyglow, natural-sky units R = B/B_nat)
- index.html (entry page)
- astro.almanac.test.mjs
- createAstroClient
- fallback.js
- mountShell
- astro.snapshot.test.mjs
- ui.a11y-css.test.mjs
- Standing on Mars: directions, IAU local frame, magnitudes
- createBus
- render/eclipse-path.js
- createSunPath
- render.shaders.test.mjs
- Airmass and extinction (Kasten-Young, k = 0.2 mag)
- worker.js
- astro.frames.test.mjs
- js_data_catalog
- context-loss.js
- diagnostics.js
- astro.events-p6.test.mjs
- lunarVisibility
- debug.js
- three-hooks.mjs

## God Nodes (most connected - your core abstractions)
1. `t()` - 329 edges
2. `createRig()` - 121 edges
3. `The astronomy behind Planet Location Marker (ASTRONOMY.md)` - 100 edges
4. `createActions()` - 91 edges
5. `computeSnapshot()` - 88 edges
6. `h()` - 88 edges
7. `Planet Location Marker architecture (ARCHITECTURE.md)` - 86 edges
8. `setText()` - 74 edges
9. `createSnapshot()` - 73 edges
10. `boot()` - 66 edges

## Surprising Connections (you probably didn't know these)
- `Architecture` --references--> `byTz()`  [INFERRED]
  CLAUDE.md → js/geo/cities.js
- `Development` --references--> `stats()`  [INFERRED]
  CLAUDE.md → js/render/context.js
- `Matrix layout gotcha (Astronomy Engine rotation transpose, aeRotToM3)` --references--> `aeRotToM3()`  [EXTRACTED]
  docs/ASTRONOMY.md → js/astro/frames.js
- `Observer chain at boot (URL hash, saved prefs, largest city in the device timezone, Greenwich)` --references--> `guessObserver()`  [INFERRED]
  CLAUDE.md → js/main.js
- `Architecture` --references--> `importRenderStack()`  [INFERRED]
  CLAUDE.md → js/main.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Earth orientation pipeline (GAST + precession/nutation through S)** — docs_astronomy_gast, docs_astronomy_iau2006_precession, docs_astronomy_iau2000b_nutation, docs_astronomy_s_mapping, docs_astronomy_earth_matrix, docs_astronomy_earth_fixed_frame, docs_astronomy_static_sky [EXTRACTED 1.00]
- **Night-sky brightness model (airglow, KS91 moonlight, light pollution -> Bortle, NELM, Milky Way and zodiacal fade, night vision)** — docs_astronomy_skyglow_model, docs_astronomy_ks91, docs_astronomy_light_pollution, docs_astronomy_bortle_class, docs_astronomy_limiting_magnitude, docs_astronomy_zodiacal_light, docs_astronomy_night_vision_scotopic [EXTRACTED 1.00]
- **Hard repo rules R1-R7 enforced by tests** — docs_architecture_rule_pure_modules, docs_architecture_rule_three_confinement, docs_architecture_rule_ui_isolation, docs_architecture_rule_relative_urls, docs_architecture_rule_no_per_frame_allocation, docs_architecture_rule_shader_tonemapping, docs_architecture_rule_vector_conventions [EXTRACTED 1.00]
- **CI browser verification on one pinned Chrome (offline smoke matrix, offline reload, context loss, perf gates, goldens)** — github_workflows_ci_pinned_chrome, github_workflows_ci_offline_smoke_matrix, github_workflows_ci_offline_reload_smoke, github_workflows_ci_context_loss_smoke, github_workflows_ci_performance_gates, github_workflows_ci_golden_renders, scripts_smoke [EXTRACTED 1.00]
- **Versioned service-worker deploy pipeline (stage site, content-hashed sw.js, offline-reload smoke, Pages deploy, reload into the waiting version)** — github_workflows_pages_stage_site_step, scripts_stage_site, sw, github_workflows_ci_offline_reload_smoke, readme_offline_after_first_visit, index_reload_skip_waiting [INFERRED 0.85]
- **Boot failure path that never leaves a blank page (error capture, fatal, showPanel, loader error panel, nomodule fallback)** — index_global_error_capture, index_fatal, index_showpanel, index_pcloader, index_nomodule_fallback, claude_failure_handling [INFERRED 0.95]

## Communities (141 total, 1 thin omitted)

### Community 0 - "eyepiece.js"
Cohesion: 0.04
Nodes (104): Planet medallions (render/planets.js, PLANET_CHUNK impostor), Jupiter's Galilean moons at light time (transit, occultation, eclipse, shadow flags), Lunar libration and limb feature (AE.Libration), Planet disc frame and impostor (discFrame/discView, oblate spheroid, Saturn's rings), compressRadius(), createDiscFrame(), createDiscView(), discFrame() (+96 more)

### Community 1 - "mountTimebar"
Cohesion: 0.04
Nodes (101): Time bar and Time popover (ui/timebar.js), Tonight chart and time-bar sky strip (series, sky-palette.js), clamp(), menu(), build(), close(), open(), openPopover() (+93 more)

### Community 2 - "ref_node_assert"
Cohesion: 0.03
Nodes (45): HORIZON_SAMPLES, blank(), findImports(), KEYWORDS_BEFORE_REGEX, lineAt(), PUNCT_BEFORE_REGEX, scanJs(), FROM (+37 more)

### Community 3 - "main.js"
Cohesion: 0.05
Nodes (87): window.__pcEnv feature detection (importmap, webgl2, renderer, maxTex), eclipseFocusExpired(), selectionLook(), viewModeLook(), ribbonPlan(), photoLayers(), registerStars(), hideContextLost() (+79 more)

### Community 4 - "Beams & Labels"
Cohesion: 0.06
Nodes (75): hostBodies(), extraSky(), marsSeason(), marsSiteNear(), findIt(), guideRefs(), isExtraId(), angSize() (+67 more)

### Community 5 - "Events & Trails"
Cohesion: 0.07
Nodes (65): CelesTrak GP element sets (T. S. Kelso), Near-Earth SGP4 satellites (TEME -> Earth-fixed via GMST, shadow, brightness, passes), Vallado, Crawford, Hujsak & Kelso (2006) Revisiting Spacetrack Report #3, live-satellites (ISS and bright satellites via SGP4; TLEs refreshed at deploy), allPasses(), analysePass(), bisect(), createLook() (+57 more)

### Community 6 - "UI Hub & Shortcuts"
Cohesion: 0.08
Nodes (60): telescopeFov(), ambientSteps(), clamp(), createTourRunner(), applyStep(), applyTime(), bindInput(), build() (+52 more)

### Community 7 - "Time Bar & Scrubber"
Cohesion: 0.06
Nodes (58): cache, fill(), LOCALES, N_(), pad2(), TAGS, tn(), EXPOSE_PRESETS (+50 more)

### Community 8 - "Headless Smoke Harness"
Cohesion: 0.09
Nodes (57): skyCaption(), t(), nbsp(), on(), rovingKeys(), setText(), eventGlyph(), eventColor() (+49 more)

### Community 9 - "App Actions API"
Cohesion: 0.06
Nodes (51): createRenderContext(), beginCapture(), capture(), captureCamera(), chainCfg(), commitTier(), compile(), compileAll() (+43 more)

### Community 10 - "Body Card & Sky Now"
Cohesion: 0.07
Nodes (47): City lights at close zoom (cubic B-spline, hashed point field), Schneider (2015) real-time volumetric cloudscapes (Beer-powder), Sculpted clouds (height-field relief, Beer-powder, silver lining), ASSETS, cloudsKeyFor(), dayKeyFor(), download(), INTERIM (+39 more)

### Community 11 - "Shell, Icons & About"
Cohesion: 0.07
Nodes (57): list(), NAMES, PLANETS, placeName(), dateText(), intl(), timeText(), instances (+49 more)

### Community 12 - "snapshot.js"
Cohesion: 0.05
Nodes (45): AU_ER, AU_KM, BODY_INDEX, createGalilean(), lunarLibration(), ABER, ALTAZ, BODY_R3 (+37 more)

### Community 13 - "astro/eclipse-path.js"
Cohesion: 0.06
Nodes (56): aimAtEvent(), eclipsePathFor(), recordVideo(), standInPath(), SUN_RADIUS_KM, aeTime(), axisHit(), axisW (+48 more)

### Community 14 - "URL Hash State"
Cohesion: 0.07
Nodes (43): Planet Location Marker architecture (ARCHITECTURE.md), Nine BODIES order contract, Body classes (is-ready, is-sky, tier-*, no-webgl, is-intro, is-red), Boot sequence (10 steps, network never on the critical path), Capture for postcards and Save image (rc.capture in one task), Context-loss backoff (60 s window: restore, one tier lower, text mode), WebGL context-loss pause and restore, Code conventions (ES2022 modules, JSDoc, no TypeScript or bundler) (+35 more)

### Community 15 - "beams.js"
Cohesion: 0.07
Nodes (51): umbraNear(), enuLocal(), buildStrip(), createBeams(), apply(), boxAt(), computeAnchors(), launch() (+43 more)

### Community 16 - "createRig"
Cohesion: 0.09
Nodes (56): eclipticOf(), createRig(), afterTransition(), applyInsets(), applyRelease(), atGlobeMax(), cancelSysTween(), cancelTween() (+48 more)

### Community 17 - "Milky Way Build"
Cohesion: 0.06
Nodes (50): createMarsHost(), loadSky(), ALTAZ, B3, computeMarsSnapshot(), createMarsInfo(), createMarsMoonsProvider(), E3 (+42 more)

### Community 18 - "Frames & Moon Orientation"
Cohesion: 0.06
Nodes (47): createActions(), bodyNow(), camView(), copyDiagnostics(), copyText(), cycleTracking(), cycleView(), diagnostics() (+39 more)

### Community 19 - "Snapshot & Eclipse Geometry"
Cohesion: 0.07
Nodes (50): alongBeam(), bodyAnchors(), bodyLabelOffsets(), buildAnchors(), cardinalAnchors(), CARDINALS, clamp(), constellationAnchors() (+42 more)

### Community 20 - "The astronomy behind Planet Location Marker (ASTRONOMY.md)"
Cohesion: 0.07
Nodes (41): Extra objects registry (namespaced ids, providers, ExtraState), History: Julian dates, Moments and 'The sky you were born under', Solar-system zoom (powers of ten, orrery overlay scene), The astronomy behind Planet Location Marker (ASTRONOMY.md), Telescope aperture gain (2*log10(25deg/FOV), up to 3.5 mag), B1950 -> J2000 element rotation (FK4 -> FK5, Standish 1982), Body directions: dirS (topocentric astrometric J2000) and geoDirS (geocentric), Deep-sky objects (dso.json, illustrative visibility and sprites) (+33 more)

### Community 21 - "dom.js"
Cohesion: 0.08
Nodes (39): Panels, phone tab bar and Display (five tabs, LAYER_GROUPS), ovalSummary(), CREDITS, mountAbout(), append(), applyAttrs(), BOOL_ATTRS, FOCUSABLE (+31 more)

### Community 22 - "City Data Build"
Cohesion: 0.08
Nodes (45): bailysBeads(), chromosphereFlash(), coronaFlattening(), coronaParams(), coronaStretch(), coronaVisibility(), createBeads(), createCoronaParams() (+37 more)

### Community 23 - "h"
Cohesion: 0.09
Nodes (46): query(), debounce(), h(), kbd(), trapFocus(), actionList(), GESTURES, keysEl() (+38 more)

### Community 24 - "Vendor Pinning"
Cohesion: 0.06
Nodes (42): AURORA_SAY, clamp(), countryFor(), camDistance(), persistObserver(), playEclipse(), rememberPlace(), setObserver() (+34 more)

### Community 25 - "Sky Lines & Exposure"
Cohesion: 0.08
Nodes (39): EARTH_RADIUS_KM, HOST_BODIES, MOON_RADIUS_ER, aboveLimbDeg(), _c, createLunarPlan(), createPose(), earthAboveLimbDeg() (+31 more)

### Community 26 - "Almanac & Verdicts"
Cohesion: 0.08
Nodes (42): acceptance(), args, argText(), ASSERT, check(), checks, cleanup(), CONTEXT_LOSS (+34 more)

### Community 27 - "Simulation Clock"
Cohesion: 0.10
Nodes (37): beforeinstallprompt capture (window.__pcInstall), clearAll(), isPlainObject(), kindOf(), load(), memory, persistent(), PREF_KEYS (+29 more)

### Community 28 - "Quality Tiers & Governor"
Cohesion: 0.05
Nodes (20): aeRotToM3(), angleBetween3(), COS_OBL, dirToAltAz(), dot3(), earthFixedToEqj(), earthRotationM3(), iauBodyMatrix() (+12 more)

### Community 29 - "Icon Generator"
Cohesion: 0.10
Nodes (41): bodyRadius(), CARDINAL, DASH, drawMoon(), ECLIPTIC, eclipticSegments(), enuToChart(), fovOutline() (+33 more)

### Community 30 - "sky.js"
Cohesion: 0.08
Nodes (35): DSO_TYPE_CODE, DSO_TYPES, dsoVisibility(), K_V, LP_BINS, createDsoLayer(), tintOf(), GROUND_FRAG (+27 more)

### Community 31 - "rig.js"
Cohesion: 0.05
Nodes (42): _bF, _bR, _bU, DESCENT_BLEND, DESCENT_PITCH, DESCENT_TURN, _fF, _fG (+34 more)

### Community 32 - "Cinematic Intro"
Cohesion: 0.08
Nodes (39): EARTH_TARGET, ATM_BETA_R, clamp(), DISC_BLENDING, EXT_K, EXT_K_MARS, FALLBACK_MAG, glyphIntensity() (+31 more)

### Community 33 - "astro.precession.test.mjs"
Cohesion: 0.09
Nodes (35): angleDeg(), eclipticPole(), equinoxConstellation(), equinoxOfDate(), J2000_MS, OBLIQUITY_J2000_DEG, POLE_STARS, poleOfDate() (+27 more)

### Community 34 - "build-milkyway.mjs"
Cohesion: 0.09
Nodes (38): addSpan(), blur(), buildEdges(), distanceField(), dt1d(), fillLevel(), gaussianKernel(), H (+30 more)

### Community 35 - "check-size.mjs"
Cohesion: 0.09
Nodes (34): Render module contract {object3d, apply, update, setLayers, setViewMode, setSelection, setQuality, dispose}, modulepreload/preload hints (three, astronomy-engine, main.js, cities.json), FALLBACK_ASSETS, FALLBACK_TIERS, FILE_BUDGETS, fmt(), INTERIM, main() (+26 more)

### Community 36 - "Offline Cities"
Cohesion: 0.10
Nodes (28): createDsoProvider(), DSO_COMMON_NAMES, guestRiseSet(), AU_PER_LY, departureLine(), HISTORY, historyAfter(), historyNear() (+20 more)

### Community 37 - "clamp"
Cohesion: 0.17
Nodes (41): basisQuat(), clamp(), advance(), applyMapCamera(), applySkyCamera(), applyVantagePose(), applyViewNow(), cutVantageHome() (+33 more)

### Community 38 - "Preferences Storage"
Cohesion: 0.12
Nodes (36): approxTzForLon(), canonMemo, canonTz(), daysInMonth(), daysInMonthCal(), deviceTz(), displayTz(), FALLBACK_ZONES (+28 more)

### Community 39 - "Online Geocoder"
Cohesion: 0.08
Nodes (34): ALIASES, boundedDistance(), DEFAULT_FIELDS, foldText(), loadCities(), aliasTargets(), fuzzyDistance(), nearest() (+26 more)

### Community 40 - "Star Catalogue Build"
Cohesion: 0.14
Nodes (37): parallaxText(), cbuf, COMPASS8_WORDS, compassWord(), dms(), fmtAlt(), fmtAngSize(), fmtAz() (+29 more)

### Community 41 - "Clock Rates & Limits"
Cohesion: 0.09
Nodes (35): edgeExit(), MOON_ORBIT_REFRESH_MS, ORBIT_IDS, SIGHT_COUNT, sightAt(), sightLines(), sightStepMs(), clamp() (+27 more)

### Community 42 - "Sky Module"
Cohesion: 0.10
Nodes (24): Golden renders visual regression (pinned Chrome for Testing), annotate(), browserVersion(), GOLDEN_SCENES, main(), parseArgs(), renderScene(), ROOT (+16 more)

### Community 43 - "Package Scripts"
Cohesion: 0.12
Nodes (31): BRIGHTEST_MAG, BUCKET_MS, eclipticLonJ2000(), EVENT_MIN_ZHR, hourlyRate(), inWindow(), J2000_MS, meteorLimitMag() (+23 more)

### Community 44 - "Static Dev Server"
Cohesion: 0.09
Nodes (23): bvToRgb(), importRenderStack(), createComets(), apply(), perpAt(), buildStrip(), createCraftBeams(), apply() (+15 more)

### Community 45 - "Geocoder Tests"
Cohesion: 0.10
Nodes (33): limitingMag(), smoothstep(), BORTLE_SQM, BORTLE_SQM_MIN, bortleFromSqm(), cityCoreGlow(), cityRadiusKm(), computeSkyglow() (+25 more)

### Community 46 - "quality.js"
Cohesion: 0.12
Nodes (30): ALL_TIERS, autoStartTier(), CADENCE_PROBE_TICKS, CADENCE_STALE_MS, createGovernor(), budget(), cadenceMs(), config() (+22 more)

### Community 47 - "Globe Picking"
Cohesion: 0.13
Nodes (32): altitudeSeries(), attempt(), classifySamples(), COMPASS, compass16(), DAYTIME_CAPABLE, decideVerdict(), equipmentFor() (+24 more)

### Community 48 - "events.js"
Cohesion: 0.12
Nodes (31): apsisCache, clockFormatter(), clockFormatters, dailyDirections(), dateFormatter(), dateFormatters, dirAt(), dirInterp() (+23 more)

### Community 49 - "Coordinate Parsing"
Cohesion: 0.13
Nodes (28): expose(), restoreExposeClock(), nextDarkMs(), trailsLook(), box(), createMp4Muxer(), moov(), stsd() (+20 more)

### Community 50 - "locale"
Cohesion: 0.10
Nodes (23): locale(), createGeocoder(), search(), setStatus(), createLruCache(), finite(), makePlace(), nominatim (+15 more)

### Community 51 - "Frame Loop & Strikes"
Cohesion: 0.27
Nodes (28): apsis(), body(), brilliancy(), circle(), circlePath(), clamp01(), conjunction(), elongation() (+20 more)

### Community 52 - "State Store"
Cohesion: 0.11
Nodes (25): buildCities(), byPopDesc(), CACHE, ensureSources(), FIELDS, main(), normaliseZones(), OUT (+17 more)

### Community 53 - "astro/comets.js"
Cohesion: 0.11
Nodes (25): anglesOf(), cometGeocentric(), cometHelioEqj(), cometMagnitude(), eclToEq(), elementsB1950ToJ2000(), eqToEcl(), fillTails() (+17 more)

### Community 54 - "Retrograde Paths"
Cohesion: 0.09
Nodes (30): OBLIQUITY_J2000_DEG, clamp(), COS_E, createSystemPose(), ECL_NORTH_S, ECL_X_S, ECL_Y_S, eclipticDir() (+22 more)

### Community 55 - "flare.js"
Cohesion: 0.11
Nodes (25): extinctionRGB(), limbTransmittance(), SUN_INTENSITY, clamp(), createFlare(), apply(), dispose(), update() (+17 more)

### Community 56 - "Worker Client"
Cohesion: 0.11
Nodes (25): CRAFT_INFO, craftStateAt(), DSN, DSN_MIN_ELEV_DEG, dsnInView(), fmtRadioTime(), hermite(), hermiteRate() (+17 more)

### Community 57 - "url-state.js"
Cohesion: 0.16
Nodes (29): bindUrl(), schedule(), write(), CAM, camToCode(), clamp(), cleanName(), enc() (+21 more)

### Community 58 - "Layout Shell"
Cohesion: 0.11
Nodes (26): DEG2RAD, AURORA_KP, AURORA_PERIOD_S, AURORA_SETTINGS, auroraText(), boundaryLat(), COEF, createAurora() (+18 more)

### Community 59 - "Event Search Tests"
Cohesion: 0.09
Nodes (13): Vector/matrix convention (Float64Array(3), row-major Float64Array(9); column-major Float64Array(16) for three.js), i18n-a11y-readiness (English-keyed i18n, Vietnamese first, contrast and transparency modes), regression-gates-ci (visual goldens and count-based perf budgets in CI), CI workflow (ci.yml), Context loss and restore smoke (Medium: composer, MSAA, bloom), Generated-data freshness check (build-sky / build-milkyway --check), Golden-render comparison (eight fixed scenes; fail above 0.5 % of pixels moving more than 6/255 luma), CI test job: tests, budgets and headless smoke (+5 more)

### Community 60 - "Shader Domain Test"
Cohesion: 0.14
Nodes (13): Render-on-demand frame loop (dirty or animating, three-strike module guard, governor sampling), idle-supersampling (Halton-jittered progressive average when settled), Phase 5: Camera, storytelling & sharing, AccumPass, makeMaterial(), ATMO_MODEL, AURORA_CHUNK, COMMON (+5 more)

### Community 61 - "THIRD_PARTY_NOTICES.md"
Cohesion: 0.08
Nodes (23): Import map (three -> vendor/three), Accuracy, Credits and licences, How it is built, Keyboard shortcuts, [→ Open Planet Location Marker](https://anshler.github.io/planet-location-marker/), Planet Location Marker, Astronomy Engine — MIT (+15 more)

### Community 62 - "Snapshot Detail Levels"
Cohesion: 0.14
Nodes (26): Globe <-> sky transition (skyBlend, groundCover, descent pitch-up), sunAngularRadius(), urbanIndex(), createAtmosphere(), refresh(), definesFor(), modelOf(), SEGMENTS_BY_TIER (+18 more)

### Community 63 - "Snapshot Tests"
Cohesion: 0.12
Nodes (22): CRAFT_URL, DSO_URL, registerExtras(), STARINFO_URL, TLE_URL, createCometProvider(), createCraftProvider(), decodeCraft() (+14 more)

### Community 64 - "camera.mapview.test.mjs"
Cohesion: 0.15
Nodes (19): clamp(), clampMapCenter(), createMapFrame(), MAP_HALF_H, MAP_HALF_W, MAP_LIFT, MAP_SCALE, mapFitDistance() (+11 more)

### Community 65 - "City Search Matching"
Cohesion: 0.12
Nodes (24): addon(), AE, checkEntry(), D3C, DERIVED_LOCK, listFiles(), LOCK, main() (+16 more)

### Community 66 - "stage-site.mjs"
Cohesion: 0.13
Nodes (23): resolveDocumentUrl(), ALLOWED_DOTFILES, appVersion(), buildManifest(), EXCLUDED_DIR_NAMES, EXCLUDED_PATHS, EXCLUDED_ROOT_FILES, FRESH_FILES (+15 more)

### Community 67 - "loop.js"
Cohesion: 0.09
Nodes (17): FEATURE_NAMES, FULL_INTERVAL_MS, labelMode(), MAP_HIDE_K, MAX_DT_MS, OPT_FRAME, OPT_FULL, ORBIT_LABEL_CAP (+9 more)

### Community 68 - "repo.tooling.test.mjs"
Cohesion: 0.11
Nodes (17): INFO_TIERS, STAGING_BUDGET, TIER_BUDGETS, createStaticServer(), download(), MIME, mimeFor(), normalisePrefix() (+9 more)

### Community 69 - "camera.rig.test.mjs"
Cohesion: 0.11
Nodes (13): checkFrame(), FakeCanvas, HCMC, LUXOR, makeApp(), makeRig(), near(), PARIS (+5 more)

### Community 70 - "createLoop"
Cohesion: 0.19
Nodes (24): createLoop(), advanceMovers(), broadcast(), callModule(), computeSecond(), disable(), feedCadence(), fillSkyglow() (+16 more)

### Community 71 - "Service Worker"
Cohesion: 0.17
Nodes (22): AIM_IDLE_MS, AIM_TAU_MOVING_MS, AIM_TAU_STILL_MS, aimFilterStep(), clamp(), createAim(), holdLock(), onOrientation() (+14 more)

### Community 72 - "tooling.perf-gates.test.mjs"
Cohesion: 0.11
Nodes (11): probe(), judgePerf(), PERF_BUDGETS, PERF_SHIM, PERF_WINDOW_MS, perfProbe(), perfScene(), perfSummary() (+3 more)

### Community 73 - "Debug Overlay"
Cohesion: 0.16
Nodes (23): Label anchors, priorities and UI occluders (no layout reads in a frame), createLabels(), acquire(), applyAnchorToEl(), declutter(), makeEl(), measure(), project() (+15 more)

### Community 74 - "astro/extras.js"
Cohesion: 0.12
Nodes (18): extraOf(), LIGHT_S_PER_AU, createExtras(), ensure(), rebuild(), createExtraState(), extraAltAz(), _rd (+10 more)

### Community 75 - "core.url-state.test.mjs"
Cohesion: 0.09
Nodes (17): LAYER_LABELS, FAMOUS_COMETS, LY_CRAFT, MOMENTS, DEFAULT_STATE, codeToLayers(), DEFAULT_LAYER_CODE, LAYER_CODES (+9 more)

### Community 76 - "astro.dso.test.mjs"
Cohesion: 0.10
Nodes (20): DSO_LABEL_EFF_MAG, sizeWords(), buildDso(), D3_TYPE, EXTRAS, FIELDS, main(), MESSIER_FIX (+12 more)

### Community 77 - "push"
Cohesion: 0.13
Nodes (25): appulseEvent(), apsidesOfYear(), constellationOf(), describeOpposition(), fmtMeteorRate(), fmtSep(), greatestElongations(), horizontal() (+17 more)

### Community 78 - "build-sky.mjs"
Cohesion: 0.15
Nodes (21): buildCons(), buildNames(), buildPm(), buildSky(), buildStarInfo(), buildStars(), cleanDesig(), hipRows() (+13 more)

### Community 79 - "earthMatrix = S*(PN*Rz(GAST))*S^T"
Cohesion: 0.14
Nodes (21): Eclipse in focus, path ribbon and Eclipse Companion (ui.eclipse), Place search sky preview (placeSky from readout sub-points), Shadow chase (actions.chaseEclipse, rig.follow), Accuracy budget, Astronomy Engine (Don Cross, MIT), Central solar eclipse path (eclipsePath on AE's ellipsoid, limits, citiesInPath), Earth-fixed frame (EF), earthMatrix = S*(PN*Rz(GAST))*S^T (+13 more)

### Community 80 - "createClock"
Cohesion: 0.26
Nodes (23): clamp01(), clampT(), createClock(), advanceRange(), clampStop(), effRate(), endRange(), flush() (+15 more)

### Community 81 - "createSky"
Cohesion: 0.13
Nodes (19): altAzLocal(), createSky(), apply(), applyMagLimit(), buildStaticLines(), dispose(), refreshDetail(), setCatalog() (+11 more)

### Community 82 - "sampling.js"
Cohesion: 0.17
Nodes (20): Fast-time star streaks (render/streaks.js, STREAK_VERT_CHUNK), createSupersampler(), fresh(), jitter(), halton(), SS_DRIFT_PX, SS_DRIFT_WEIGHT, SS_STILL_PX (+12 more)

### Community 83 - "sw.js"
Cohesion: 0.23
Nodes (22): data/cities.json preload (skipped under a controlling service worker), cacheable(), carryOver(), DEV_PRECACHE, fetchInto(), fetchManifest(), FRESH_DEFAULT, installDev() (+14 more)

### Community 84 - "app.capture.test.mjs"
Cohesion: 0.11
Nodes (12): ANALEMMA_DAYS, ANALEMMA_S, analemmaPlan(), clamp(), DARK_SUN_DEG, EXPOSE_HIDDEN_LAYERS, EXPOSE_KINDS, meanNoonMs() (+4 more)

### Community 85 - "playIntro"
Cohesion: 0.18
Nodes (20): easeInOutCubic(), easeOutQuart(), INTRO_TIMING, introStartDir(), mulDir(), mulDirT(), normalize(), playIntro() (+12 more)

### Community 86 - "sky-guide.js"
Cohesion: 0.13
Nodes (21): _a, _b, BRIGHT_STARS, clamp(), COMPASS16_WORDS, compassWords16(), DIR8, DIR8_PHRASES (+13 more)

### Community 87 - "horizon.js"
Cohesion: 0.17
Nodes (19): buildHorizon(), building(), clamp(), FAR_RIDGE_MAX_DEG, horizonKey(), horizonSeed(), NEAR_BAND_MAX_DEG, periodicFbm() (+11 more)

### Community 88 - "app.eclipse-chase.test.mjs"
Cohesion: 0.19
Nodes (19): CHASE_DURATION_S, CHASE_HOLD_MS, CHASE_OVERVIEW_DIST, CHASE_POSE, chaseLegs(), chaseTarget(), createEclipseChase(), end() (+11 more)

### Community 89 - "photometry.js"
Cohesion: 0.15
Nodes (19): buildBvLut(), bvToKelvin(), cieX(), cieY(), cieZ(), clamp01(), eclipseStarLimitMag(), exposureFor() (+11 more)

### Community 90 - "ui.ics.test.mjs"
Cohesion: 0.19
Nodes (18): addToCalendar(), buildCalendar(), ECLIPSE_KINDS, escapeText(), eventSpan(), finite(), foldLine(), icsDate() (+10 more)

### Community 91 - "scripts"
Cohesion: 0.09
Nodes (21): name, private, scripts, data, golden, icons, preload, size (+13 more)

### Community 92 - "build-icons.mjs"
Cohesion: 0.14
Nodes (20): compilePaint(), compileShape(), design(), DIR, EARTH, ellipseDistance(), fmt(), hexRgb() (+12 more)

### Community 93 - "build-textures.mjs"
Cohesion: 0.16
Nodes (16): build(), checkDerived(), DERIVED_LOCK, imageSize(), isCachedSource(), main(), readLockFile(), readOrNull() (+8 more)

### Community 94 - "app.wake-lock.test.mjs"
Cohesion: 0.12
Nodes (13): Night-vision first-paint script (pc2.display red -> is-red class, black theme-color), createWakeLock(), bind(), drop(), sync(), LISTEN, noop(), WAKE_IDLE_MS (+5 more)

### Community 95 - "app.tier-switch.test.mjs"
Cohesion: 0.14
Nodes (7): hitch-free-tier-switch (compile and upload the next tier before swapping), createTierSwitch(), bounded(), call(), loop(), report(), sameTier()

### Community 96 - "capture.js"
Cohesion: 0.17
Nodes (18): createCapture(), drawLabels(), frame(), FONT_STACK, fontFor(), KIND_RANK, LABEL_STYLES, labelText() (+10 more)

### Community 97 - "planner.js"
Cohesion: 0.16
Nodes (15): aeObserverOf(), toNumber(), clampInt(), PLANNER_ALT_MIN, PLANNER_BODIES, PLANNER_GLARE_DEG, raDecOfDate(), visibilityYear() (+7 more)

### Community 98 - "mars-sky.js"
Cohesion: 0.15
Nodes (14): EARTH_SLOT, clamp(), createMarsSky(), dispose(), setViewMode(), update(), EARTH_BLUE, smooth() (+6 more)

### Community 99 - "createMeteors"
Cohesion: 0.23
Nodes (20): hash01(), meteorAlpha(), meteorShape(), poissonCount(), sampleMagnitude(), clamp01(), createMeteors(), buildComposite() (+12 more)

### Community 100 - "wrap360"
Cohesion: 0.16
Nodes (20): altCeil(), anchoredLook(), applyBlend(), camRay(), endTrack(), lookFromForward(), setAnchor(), skyDirAt() (+12 more)

### Community 101 - "camera.system.test.mjs"
Cohesion: 0.12
Nodes (5): FakeCanvas, HCMC, makeRig(), snapAt(), T_OPP

### Community 102 - "createSwClient"
Cohesion: 0.20
Nodes (15): Reload button: activate the waiting service worker (skip-waiting) before reloading, createSwClient(), activate(), askVersion(), offer(), onControllerChange(), onMessage(), readVersion() (+7 more)

### Community 103 - "ae.js"
Cohesion: 0.20
Nodes (13): AE, apparentPath(), bisectStation(), eclLonAt(), geoVector(), GHOST_DAYS, interpolatedDir(), interpolatedStation() (+5 more)

### Community 104 - "picking.js"
Cohesion: 0.16
Nodes (18): raySphere(), _app, _d, _hit, _l, _lift, _ll, ndcXY() (+10 more)

### Community 105 - "liftByRefraction"
Cohesion: 0.26
Nodes (18): liftByRefraction(), fmtAngle(), handSpan(), rulerText(), vectorAngleDeg(), COLOR, createRuler(), apply() (+10 more)

### Community 106 - "clock.js"
Cohesion: 0.16
Nodes (14): BIT, easeRange(), EVENT_ORDER, logEase(), MAX_MS, MAX_RATE, MIN_MS, nextRate() (+6 more)

### Community 107 - "createTextureStore"
Cohesion: 0.22
Nodes (18): afterFrame(), bitmapDecodeUsable(), createTextureStore(), decode(), drop(), emit(), entryOf(), fetchBlob() (+10 more)

### Community 108 - "createStore"
Cohesion: 0.14
Nodes (16): FINE_FOV_DEG, TWINKLE_FRAME_MS, createStore(), deliver(), notify(), sourceFor(), makeActions(), state() (+8 more)

### Community 109 - "BODIES"
Cohesion: 0.19
Nodes (13): BODIES, SUN_ANG_RADIUS_1AU_RAD, clamp(), discVisibleFraction(), EARTH_SHADOW_RADIUS_ER, GL3, lunarEclipseLight(), NODES (+5 more)

### Community 110 - "msOf"
Cohesion: 0.23
Nodes (18): cap(), centralDurS(), centralPhaseUp(), fmtDurS(), fmtLat(), fmtLon(), globalSolarEclipses(), localEclipseDetail() (+10 more)

### Community 111 - "year-planner.js"
Cohesion: 0.21
Nodes (16): plannerSummary(), plannerVisible(), createYearPlanner(), draw(), firstMidnight(), nightIndex(), request(), requestSun() (+8 more)

### Community 112 - "store.js"
Cohesion: 0.15
Nodes (14): State model: store (observer, observer2, host, selection, view, layers, display, quality, ui, status) and clock, mirrored in the URL hash, Phase 6: Time machine & sky content, stand-on-mars (Mars observer, sols/LMST clock, host=mars), AURORA_SETTINGS, deepFreeze(), freezeShallow(), HOST_DEFAULT, isPlainObject() (+6 more)

### Community 113 - "edge-chips.js"
Cohesion: 0.24
Nodes (16): Finding it in the real sky (edge chips, angle ruler, Find it, Point at the sky), Pointing the phone (W3C DeviceOrientation, compass Align), edgeHit(), chipMagLimit(), createEdgeChips(), cmp(), hideAll(), occluded() (+8 more)

### Community 114 - "Roadmap: v2.1 "breathtaking""
Cohesion: 0.12
Nodes (14): aurora-oval (IGRF dipole + Starkov ovals, volumetric limb curtains on high/max), Dropped at review, eclipse-companion (countdown and contact-timeline HUD), eclipse-path-of-totality (globe ribbon; matches NASA for 2027-08-02), eclipse-shadow-chase (ride the Moon's shadow, actions.chaseEclipse), How to continue, Phase 0: Bug sweep & quick wins, Phase 1: Eclipse 2027 (+6 more)

### Community 115 - "Architecture"
Cohesion: 0.17
Nodes (13): Architecture, Development, graphify, Observer chain at boot (URL hash, saved prefs, largest city in the device timezone, Greenwich), Quality tiers (automatic low/medium/high, downgrade-only governor, manual max), Scene frame (+Y = J2000 north, 1 unit = Earth radius, S: (x,y,z)->(x,z,-y), earthMatrix = S(PN Rz(GAST))S^T), Snapshots: computeSnapshot 'frame' detail for rendering, 'full' detail at 4 Hz as bus 'readout', What this is (+5 more)

### Community 116 - "Features"
Cohesion: 0.13
Nodes (14): context-loss-backoff-and-diagnostics (memory-pressure-aware recovery, Copy diagnostics), Phase 7: Interface, performance & engineering, sw-atomic-updates-offline-ci (content-hashed versions, atomic precache, offline-reload smoke), ui-redesign (one labelled toolbar, five tabs by intent, Time popover, mode chips, folding Display), A beam to every world (nine light-time-corrected beams; dashed x-ray below the horizon), Copy diagnostics (one JSON report, never the location; prefilled issue), Deep links (every view is a shareable URL), Eclipse companion (countdown to each contact, jump to just before totality) (+6 more)

### Community 117 - "astro.events.test.mjs"
Cohesion: 0.13
Nodes (12): upcomingEvents(), eclipseAt(), from2024, from2026, fromJune2027, HANOI, hanoi2024, hanoi2026 (+4 more)

### Community 118 - "Night-sky brightness model (computeSkyglow, natural-sky units R = B/B_nat)"
Cohesion: 0.15
Nodes (14): Bortle (2001) Dark-Sky Scale, Bortle class and Sky darkness setting, IMO Meteor Shower Calendar, Jenniskens (1994) meteor stream activity, Krisciunas & Schaefer (1991) moonlight model, Leinert et al. (1998) reference of diffuse night-sky brightness, Walker's-law light pollution with city-core cap (16 azimuth bins), Limiting magnitude from SQM (Schaefer-type fit) (+6 more)

### Community 119 - "index.html (entry page)"
Cohesion: 0.22
Nodes (13): index.html (entry page), Inline critical CSS (loader, no-webgl, is-intro body classes), fatal(), Global error capture (error / unhandledrejection before __pcBooted), Inline loader screen (#loader, progress bar, rotating tips), Loader locale table and window.__pcT (Vietnamese before any module loads), nomodule unsupported-browser fallback, window.__pcLoader (progress, done, fatal, unsupported) (+5 more)

### Community 120 - "astro.almanac.test.mjs"
Cohesion: 0.14
Nodes (9): sunAltitudeSeries(), BODY_IDS, twilightClass(), GREENWICH, HANOI, TROMSO, DAY_START, HANOI (+1 more)

### Community 121 - "createAstroClient"
Cohesion: 0.30
Nodes (13): abortError(), createAstroClient(), call(), dispose(), eclipsePath(), ensureWorker(), onMessage(), pump() (+5 more)

### Community 122 - "fallback.js"
Cohesion: 0.29
Nodes (11): Failure handling (text mode, context-loss backoff, placeholders with toast, loader error panel), 3D module preloads (three.js, render stack, Earth previews) gated on WebGL2, import maps and context-loss state, armReload(), contextRestoring(), COPY, el(), ensureStyle(), showContextLost() (+3 more)

### Community 123 - "mountShell"
Cohesion: 0.41
Nodes (12): mountShell(), applyLayout(), computeLayout(), measureSheet(), measureTimebar(), openPanel(), placeInk(), selectTab() (+4 more)

### Community 124 - "astro.snapshot.test.mjs"
Cohesion: 0.17
Nodes (4): CONTACT_CASES, FULL, HONOLULU, numbersIn()

### Community 125 - "ui.a11y-css.test.mjs"
Cohesion: 0.20
Nodes (7): contrast(), css, lin(), lum(), root, sky, WHITE

### Community 126 - "Standing on Mars: directions, IAU local frame, magnitudes"
Cohesion: 0.18
Nodes (11): Fixed render order (SPEC E.1), Allison & McEwen (2000) areocentric solar coordinates (Mars24), IAU WGCCRE rotational elements (Archinal et al. 2018), Hand angles and 'Find it' directions (handSpan, findIt, ruler), Jacobson (2010) and Brozovic et al. (2025) Martian satellite orbits, Mallama & Hilton (2018) apparent planetary magnitudes, Mars clock (MSD, MTC, LMST, Ls; Mars24), Standing on Mars: directions, IAU local frame, magnitudes (+3 more)

### Community 127 - "createBus"
Cohesion: 0.33
Nodes (8): BUS_EVENTS, createBus(), add(), clear(), off(), on(), once(), remove()

### Community 128 - "render/eclipse-path.js"
Cohesion: 0.33
Nodes (10): ANNULAR, createEclipsePath(), apply(), clear(), placeMarker(), show(), update(), updateVisibility() (+2 more)

### Community 129 - "createSunPath"
Cohesion: 0.33
Nodes (11): clamp01(), createSunPath(), apply(), build(), invalidate(), keyFor(), maybeRequest(), polyline() (+3 more)

### Community 130 - "render.shaders.test.mjs"
Cohesion: 0.24
Nodes (10): firstArgs(), KNOWN_CLAMPED_TRIG_ARGS, KNOWN_POSITIVE_BASES, KNOWN_SAFE_LOG_ARGS, ourGlsl(), read(), ROOT, SHADER_DIR (+2 more)

### Community 131 - "Airmass and extinction (Kasten-Young, k = 0.2 mag)"
Cohesion: 0.22
Nodes (10): Flat world map (view.mode map, mapK morph in SURFACE_VERTEX), Airmass and extinction (Kasten-Young, k = 0.2 mag), Chromatic scintillation of low bright stars (twinkle), Kasten & Young (1989) air mass, Tonight visibility verdicts and altitude series, Twilight classes by solar altitude, World map: equirectangular, lit from the sphere (geocentric twilight contours), Year planner (visibilityYear analytic altitudes) (+2 more)

### Community 132 - "worker.js"
Cohesion: 0.38
Nodes (9): moonOrbitPolyline(), orbitPolylines(), put32(), handleMessage(), OPS, riseSetAll(), runOp(), serializeError() (+1 more)

### Community 133 - "astro.frames.test.mjs"
Cohesion: 0.22
Nodes (3): randomSkyCases(), rng(), iso()

### Community 134 - "js_data_catalog"
Cohesion: 0.28
Nodes (7): Max tier (manual only, no budget, 8K maps), Sky dome all-sky chart (ui/sky-dome.js), Ballesteros (2012) black-body colours, Max tier deeper stars (stars8.json, V 6-8), Hipparcos and Tycho Catalogues (ESA 1997), Star sky catalogue (5,044 Hipparcos stars to mag 6, sky.json), Star colour from B-V (Ballesteros + Planck x CIE 1931)

### Community 135 - "context-loss.js"
Cohesion: 0.58
Nodes (7): capTier(), LOSS_WINDOW_MS, lossRecord(), rank(), recordLoss(), retryRecord(), tierBelow()

### Community 136 - "diagnostics.js"
Cohesion: 0.42
Nodes (7): buildDiagnostics(), DIAG_HASH_KEYS, DIAG_MAX_ERRORS, diagHash(), num(), scrubError(), diagnostics()

### Community 137 - "astro.events-p6.test.mjs"
Cohesion: 0.33
Nodes (4): OCCULTATION_STARS, HCMC, PARIS, paris2026

### Community 138 - "lunarVisibility"
Cohesion: 0.50
Nodes (5): horizonCrossing(), lunarPhaseAt(), lunarVisibility(), moonAltAt(), visibleOffsetMin()

### Community 139 - "debug.js"
Cohesion: 0.60
Nodes (4): createDebugOverlay(), drawSpark(), refresh(), formatCount()

## Knowledge Gaps
- **32 isolated node(s):** `./lazy.js`, `RFC-5545`, `RFC-5545`, `Schneider (2015) real-time volumetric cloudscapes (Beer-powder)`, `true-light-time-pulses — rejected by the verifier` (+27 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1213 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `t()` connect `Headless Smoke Harness` to `eyepiece.js`, `mountTimebar`, `main.js`, `Beams & Labels`, `Events & Trails`, `UI Hub & Shortcuts`, `Time Bar & Scrubber`, `lunarVisibility`, `Shell, Icons & About`, `astro/eclipse-path.js`, `URL Hash State`, `Milky Way Build`, `Frames & Moon Orientation`, `Snapshot & Eclipse Geometry`, `dom.js`, `h`, `Vendor Pinning`, `Simulation Clock`, `Icon Generator`, `Cinematic Intro`, `astro.precession.test.mjs`, `Offline Cities`, `Star Catalogue Build`, `Package Scripts`, `Globe Picking`, `events.js`, `Coordinate Parsing`, `astro/comets.js`, `Worker Client`, `Layout Shell`, `Snapshot Tests`, `loop.js`, `createLoop`, `push`, `createClock`, `sky-guide.js`, `app.eclipse-chase.test.mjs`, `ui.ics.test.mjs`, `createMeteors`, `createSwClient`, `liftByRefraction`, `msOf`, `year-planner.js`, `edge-chips.js`, `fallback.js`, `mountShell`?**
  _High betweenness centrality (0.150) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `t()` (e.g. with `flush()` and `goLive()`) actually correct?**
  _`t()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `./lazy.js`, `RFC-5545`, `RFC-5545` to the rest of the system?**
  _32 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `eyepiece.js` be split into smaller, more focused modules?**
  _Cohesion score 0.0418001525553013 - nodes in this community are weakly interconnected._
- **Why does `createActions()` connect `Frames & Moon Orientation` to `main.js`, `Beams & Labels`, `camera.rig.test.mjs`, `UI Hub & Shortcuts`, `Star Catalogue Build`, `Headless Smoke Harness`, `Shell, Icons & About`, `snapshot.js`, `astro/eclipse-path.js`, `createStore`, `Coordinate Parsing`, `locale`, `app.capture.test.mjs`, `Vendor Pinning`, `url-state.js`, `app.eclipse-chase.test.mjs`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Should `mountTimebar` be split into smaller, more focused modules?**
  _Cohesion score 0.0396330910349602 - nodes in this community are weakly interconnected._
- **Why does `createLoop()` connect `createLoop` to `loop.js`, `main.js`, `Time Bar & Scrubber`, `Headless Smoke Harness`, `snapshot.js`, `Geocoder Tests`, `URL Hash State`, `createStore`, `sampling.js`, `app.capture.test.mjs`, `photometry.js`, `app.tier-switch.test.mjs`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._