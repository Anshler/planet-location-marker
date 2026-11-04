# Roadmap: v2.1 "breathtaking"

Tracker for the improvement programme that came out of the November 2026 review. Seven reviewers
(globe, sky view, bodies, camera, interface, performance, astronomy) audited the code; an adversarial
verifier checked every proposal against the code and the hard rules, then a completeness critic
looked for gaps. 104 ideas were proposed and 103 survived, many with corrected scope.

- **Details for every item** (pitch, current state with file:line, proposal, the verifier's
  corrections, risks): [roadmap/IDEAS.md](roadmap/IDEAS.md), searchable by id.
- **The verifier's corrections override the original proposal** where they disagree.
- **Branch:** `v2.1-breathtaking`.

## How to continue

1. Pick the first `todo` item in the lowest phase, and read its entry in IDEAS.md.
2. Implement it under the rules in CLAUDE.md and docs/ARCHITECTURE.md.
3. Run `npm test`, `npm run size` and `npm run smoke`. Take a `--gpu` screenshot for visual work.
4. Set the status here (`done` with the commit, or `dropped` with the reason) and add a line to the log.

Status values: `todo` · `wip` · `done` · `dropped`. Impact is 1–5 after verification.
Effort: S < ½ day, M ≈ 1–2 days, L ≈ 3–5 days, XL > 1 week.

## Phase 0: Bug sweep & quick wins

Verified defects with repros, plus small polish. Do these first; several later items depend on them (eclipse geometry, label policy).

| Status | ID | Item | Impact | Effort | Notes |
|---|---|---|---|---|---|
| done | `eclipse-geometry-mismatch` | Bug: sky view uses three inconsistent eclipse geometries (drawn totality ~35 s late, sky darkening ~17 s early) | 4 | S | b5954ff. |
| done | `umbra-radius-bug` | Bug: the globe's umbra is drawn ~19% too narrow (constant solar radius in two shaders) | 2 | S | b5954ff. |
| done | `totality-star-budget` | Bug: totality shows stars to mag 5.7 (the Praesepe cluster) instead of planets and first-magnitude stars | 3 | S | b5954ff (limit set in magnitudes, 2.0 at totality). |
| done | `bug-skylink-return-pose` | Bug: shared sky-view links send 'Globe' to a random spot | 3 | S | db6a9ff. |
| done | `bug-event-jump-double-flight` | Bug: event jumps from sky view fly away, then back, in two sequential moves | 2 | S | db6a9ff. |
| done | `bug-center-behind-camera` | Bug: 'Center' and double-click-to-fly put the body behind the camera | 3 | S | db6a9ff (anti-body framing; 'View from <body>' kept as its own action). |
| done | `bug-eclipse-visibility-single-instant` | Bug: eclipse visibility is judged at a single instant, so a total eclipse below the horizon is billed 'visible here' | 2 | S | 0e459de. |
| done | `below-label-mismatch` | Bug: body label says 'below horizon' while its beam is drawn above (refraction/limb mismatch) | 2 | S | 188585f. |
| done | `deeplink-opens-details` | A shared link with a selected body opens on the wrong tab, and the phone strip doesn't scroll to it | 2 | S | ac4128a. |
| done | `timebar-truncation` | Time-bar truncation: the phone date loses its year by 1 px, and the desktop zone chip cuts the city | 2 | S | ac4128a. |
| done | `mobile-no-aa` | Bug: phones (medium tier) render with no anti-aliasing at all | 3 | S | Also covers `mobile-fxaa-final-pass`. ef5633e (FXAA in the final pass). |
| done | `tier-consistency` | Bug: different weather per tier, and a dirty low-tier ocean mask | 2 | S | bea6624. |
| done | `low-tier-texture-diet` | Texture diet: the Low tier's '2K' day map is larger than the 4K one; ship a 2K night map, re-encode, and add WebP variants | 3 | M | bea6624 (derived 2k WebP via scripts/build-textures.mjs). Follow-ups: Moon to WebP (about −160 KB per tier), WebP 4k twins, 4:2:0 night-light colour. |
| done | `battery-twinkle-cap-and-idle-park` | Battery: cap twinkle-only rendering at 30 Hz and park the rAF loop when nothing changes | 3 | S | ef5633e (twinkle only while stars show, ≤30 Hz). Optional follow-up: park rAF when idle. |
| done | `daylight-label-policy` | Daylight label policy: no names for stars you cannot see, and no dark embossed halos on a bright sky | 3 | S | Also covers `daylight-label-hygiene`. 188585f. |
| done | `timelapse-layout-thrash` | Fix the time-lapse layout thrash: the scrubber and view-insets force two synchronous layouts every frame | 2 | S | ac4128a. |
| done | `governor-measures-work-not-cadence` | Governor: measure frame work (CPU + GPU timer queries) instead of rAF cadence. Stop downgrading capable GPUs under 30 Hz caps, and learn to step up | 3 | M | ef5633e (cadence-aware budget, learned tier persisted). |
| done | `bug-eqgrid-j2000` | Bug: the equatorial grid is drawn in the J2000 frame, 5.2–5.5° off the true celestial pole at the ends of the time range | 2 | S | 0e459de (grid of date). |
| done | `low-sun-white-disc` | Fix the cream-white sunset Sun: redden Preetham's forward lobe and keep the disc above its sky | 3 | S | 0e459de. |
| done | `label-reticle-offsets` | Keep labels outside discs and reticles; fix the eclipse reticle hugging the Moon | 3 | S | 188585f. |
| done | `sky-zoom-to-cursor` | Sky view: zoom toward the cursor or pinch centre, double-click to centre | 2 | S | db6a9ff. |
| done | `orbit-hierarchy` | Orbit-view hierarchy: beams thin with zoom, selection keeps its colour, constellation lines recede | 2 | S | 188585f. |

## Phase 1: Eclipse 2027

The 2 Aug 2027 total solar eclipse (Luxor, 6 m 25 s) as the signature moment. Needs eclipse-geometry-mismatch first.

| Status | ID | Item | Impact | Effort | Notes |
|---|---|---|---|---|---|
| done | `eclipse-local-circumstances-and-framing` | Eclipse quick win: contact times, totality duration and a jump that actually frames the eclipse | 4 | S | Also covers `eclipse-framing-moon-scale`. 92a8599 (contacts C1–C4 and U1–U4 in events; jumps land at C2 − 20 s, 5°, playing). The magnifier option was skipped. |
| done | `eclipse-path-of-totality` | Path of totality on the globe, with cities in the path and 'move me into the path' ★ | 4 | L | Also covers `eclipse-shadow-story`. 92a8599 (pure path + worker op + citiesInPath + standInPath) and 26d7d28 (globe ribbon, umbra marker, 30-min ticks). Matches NASA: 2027-08-02 greatest 25.49N 33.19E, 261 km. |
| done | `totality-sequence` | Totality from the ground: structured corona, Baily's beads, diamond ring, prominences, shadow bands ★ | 5 | L | Also covers `totality-spectacle`. a427a84 (Baumbach corona, streamers, plumes, chromosphere, prominences, CPU Baily's beads, diamond ring, 360° horizon ring). Illustrative in detail. |
| done | `eclipse-companion` | Eclipse Companion: a countdown and contact-timeline HUD for local eclipses (ready for 2 Aug 2027) ★ | 4 | M | 5f2e302 (HUD: countdown, contact track, Play the eclipse, Jump to C2 − 20 s, Stand in the path; lunar variant; text mode). |
| done | `eclipse-shadow-chase` | Ride the Moon's shadow: eclipse chase with the path of totality drawn live ★ | 5 | L | 26d7d28 (actions.chaseEclipse: rig.follow in low orbit, ~40 s across the path). |
| done | `eclipse-aware-pin` | Eclipse-aware pin: get out of the umbra's way and mark the racing shadow | 3 | M | 26d7d28 (pin and beam roots clear around the umbra). |

## Phase 2: Sky view 2.0

Fill the empty ground, make night and twilight physically right.

| Status | ID | Item | Impact | Effort | Notes |
|---|---|---|---|---|---|
| done | `procedural-landscape` | Ground 2.0: a per-place horizon silhouette, sea horizons with a moon-glitter path, and sky-lit land ★ | 4 | L | a64d96d (js/geo/horizon.js per-place profile, rooftops/trees/sea sectors with glitter; one profile drives flare, picking and labels; layer 'd'). |
| done | `twilight-lit-ground` | Quick win: the ground stays visible through civil twilight and moonlight, and portrait framing shows less of it | 3 | S | a64d96d. |
| done | `real-sky-brightness` | 'Your real sky': moonlit sky plus light pollution estimated from the shipped night-lights map, with a Bortle slider ★ | 4 | L | 94afa61 (js/astro/skyglow.js: KS91 moonlight, Walker's law from cities.json, Bortle/SQM, Settings 'Sky darkness', sky= in URL). |
| done | `human-vision-rendering` | Night that looks like night: a human-eye vision model with the Purkinje shift, rod desaturation and dark adaptation | 3 | M | 94afa61 (subtle mesopic desaturation in sky view). |
| done | `sky-view-refraction` | Draw refraction in sky view: the Sun is hidden at the official sunset, and low discs never flatten | 3 | M | a64d96d (drawn refraction; upper limb on the horizon at the official sunset). |
| done | `procedural-flare` | Procedural lens flare: clean aperture ghosts instead of muddy textured discs (and −68 KB) | 2 | M | 94afa61 (procedural ghosts and starburst; lens-flare textures dropped). |
| done | `zodiacal-light-airglow` | Zodiacal light, gegenschein and true-colour airglow for dark skies | 2 | M | 94afa61 (medium+). |
| done | `chromatic-scintillation` | Chromatic scintillation for bright low stars (Sirius flashing colours on the horizon) | 2 | S | 94afa61 (high/max). |
| todo | `physical-sky-lut` | Physically based atmosphere (Hillaire 2020 LUTs) with the Moon's umbra inside the air ★ | 4 | XL | Deferred 2026-11-04: highest cost, and the tuned Preetham + skyglow look is now good; if done, high/max only. |

## Phase 3: Planets that are planets

One planet impostor shader drives beam-end medallions, the body card and a telescope zoom.

| Status | ID | Item | Impact | Effort | Notes |
|---|---|---|---|---|---|
| done | `galilean-moons` | Jupiter's four Galilean moons, live from AE.JupiterMoons | 3 | M | 772a1a2 (js/astro/moons.js; transit/shadow flags; checked against the 2015-01-24 triple shadow transit). |
| done | `body-card-moons-rings-libration` | Details card: Jupiter's moon line-up, Saturn's ring tilt and the Moon's libration (works in text mode) | 2 | S | Also covers `eyepiece-portraits`. 772a1a2 (ui/eyepiece.js portraits: textured Moon with libration, Jupiter + moons, Saturn's rings and edge-on dates, phases; text mode). |
| done | `planet-impostor-medallions` | Real planets at the end of every beam: phase-correct mini-globes with Saturn's rings at today's tilt ★ | 4 | L | 772a1a2 (render/planets.js + shaders/planets.glsl.js shared impostor; magnified, schematic bands). |
| done | `sidereal-tracking` | Star-lock and body tracking in sky view ("the Earth turns, not the sky") ★ | 4 | M | 828f82a (track body / lock to stars, trk= in URL, K shortcut, Track chip). |
| done | `telescope-zoom` | Telescope zoom in sky view: dive from the whole sky into Jupiter and its moons ★ | 4 | XL | Also covers `eyepiece-mode`. 828f82a (FOV floor 0.2°, per-frame snapshot below 2°, true-size impostors, Galilean discs + shadows, aperture gain, Telescope button). Not done: CSS field stop and ×N label. |
| done | `retrograde-timelapse` | Retrograde loop as a time-lapse composite: weekly planet images that swell toward opposition ★ | 3 | M | 828f82a (10-day planet images sized by diameter and magnitude, 'Brightest · date' tag). |

## Phase 4: Living Earth

Globe photorealism.

| Status | ID | Item | Impact | Effort | Notes |
|---|---|---|---|---|---|
| done | `sculpted-clouds` | Sculpted clouds: relief, self-shadow, thickness and silver linings from the existing cloud map ★ | 4 | M | da679f0. |
| done | `moonlight-moonglint` | Real moonlight on the night side, plus a silver moonglint on dark oceans | 3 | S | da679f0. |
| done | `close-zoom-lights` | Close-zoom city lights: bicubic filter, sub-texel light grain, restored highlights | 3 | S | da679f0. |
| done | `aurora-oval` | Physically placed auroral ovals with volumetric curtains ★ | 4 | L | da679f0 (js/astro/geomag.js IGRF dipole + Starkov ovals; face-on term all tiers, limb curtains high/max; Settings 'Aurora activity', au= in URL; no live data). |
| todo | `orbital-horizon-view` | Orbital horizon view (ISS cupola mode): tilt the camera at low altitude ★ | 4 | L | Also covers `tilt-on-zoom-horizon`. |
| todo | `ozone-twilight-limb` | Ozone absorption in the atmosphere model: the blue band above the orbital sunset | 2 | S | Skipped in Phase 4: touches the shared ATMO_MODEL and the tuned sunset ring. |
| todo | `ocean-glint-wind` | A sunglint with texture: wind-roughness field, calm lee wakes, Fresnel sky sheen | 3 | M |  |
| todo | `seasonal-earth` | Seasonal Earth: NASA Blue Marble monthly surfaces crossfaded by simulated date ★ | 3 | L |  |
| todo | `living-weather` | Living weather time-lapse: zonal-wind flow-map advection instead of a rigid cloud spin | 2 | M |  |
| todo | `detail-tiles` | Close-zoom detail tiles (clipmap-lite) for the day and night maps | 2 | L | Also covers `zoom-streamed-8k-earth`. |

## Phase 5: Camera, storytelling & sharing

| Status | ID | Item | Impact | Effort | Notes |
|---|---|---|---|---|---|
| done | `lighten-stacking-exposure` | Long-exposure 'lighten' stacking: star trails and a real analemma photo ★ | 4 | M | 1515699 (Expose: Star trails / Analemma / Free presets, AccumPass, clock strideMs, Save image). |
| done | `sky-postcard` | Sky Postcard: share the current view as a designed image, not just a link ★ | 4 | M | 1515699 (Share → Postcard: 1080×1350 / 1200×630 / 1080×1920 rendered at size, typographic band, navigator.share). |
| done | `guided-tours` | Guided tours: "Tonight from here", "A year in a minute", the 2027 eclipse, and an ambient mode ★ | 4 | L | 93b54eb (Tonight from here, A year in a minute, Eclipse 2027, Ambient; #tour=; restores state; text mode). |
| done | `earthrise-vantage` | Vantage points: Earthrise from the Moon, and the DSCOVR view from L1 ★ | 4 | L | b57fde1 (View from L1 with the eclipse shadow on the disc; Earthrise from 150 km lunar orbit; vt= in URL). |
| done | `ar-sky-pointing` | Point your phone at the sky: compass-driven Sky view, off-screen pointers and wake lock ★ | 4 | L | d33ce37 (off-screen edge chips on all devices; 'Point at the sky' on phones with Align calibration, wake lock, auto-stop). |
| done | `intro-preroll-matchcut` | Intro: let the opening breathe, and match-cut from the loader's globe | 2 | S | 93b54eb (pre-roll done; loader match-cut partial). |
| done | `fast-time-star-streaks` | Velocity streaks to stop star strobing in fast time | 2 | M | 981a870 (render/streaks.js; subtle, reduced-motion aware, off on low). |
| done | `timelapse-video-export` | Record a time-lapse: deterministic 1080p or vertical video with labels and a date stamp burned in | 3 | L | 981a870 (Share → Video: deterministic frames, WebCodecs + in-repo MP4 muxer, MediaRecorder fallback; presets A day / Star trails / Eclipse chase). |
| done | `globe-to-map-morph` | Unroll the globe: an animated globe-to-world-map morph with the terminator, twilight bands, sub-body points and tides ★ | 3 | L | a6d1e37 (M or vantage menu; view=map, cam=m:; twilight contour lines; sub-body dots; map picking). |
| done | `orrery-zoom-out` | Powers of ten: zoom out until the beams become lines across the solar system ★ | 4 | XL | f2087a9 (zoom past 150 R into a linear-scale solar system; beams become Earth→planet lines; integrated with map, aiming, recorder). |
| done | `two-observers` | Same sky, two places: a second pin whose beams converge on the Moon | 3 | L | a6d1e37 (observer2 via 'Compare with…', loc2/n2/tz2 links; beams converge on the Moon; side-by-side Sky panel). |
| todo | `sky-soundscape` | Hear the sky: a generative, spatial soundscape that goes silent at totality | 2 | M | Skipped in batch 2 (optional). |
| done | `idle-supersampling` | Progressive supersampling when idle: render-on-demand's spare frames turned into perfectly anti-aliased stills | 2 | M | 981a870 (Halton-jittered progressive average when settled; medium 8 / high+max 16 samples; off on low). |
| done | `angle-ruler-and-fists` | Find it in the real sky: an angle ruler plus 'fists at arm's length' guidance | 3 | M | d33ce37 (A-key ruler with fists; body card 'Find it' line, text mode too). |

## Phase 6: Time machine & sky content

Use the 1000–3000 range and the unused Astronomy Engine APIs.

| Status | ID | Item | Impact | Effort | Notes |
|---|---|---|---|---|---|
| done | `events-breadth-unused-ae` | More real events from unused Astronomy Engine searches: Antares/Pleiades occultations, Venus at greatest brilliancy, transits, perigee, ring-plane crossing | 3 | M | 612b08e (occultations, Venus brilliancy, transits, perigee/supermoons, ring-plane crossings). |
| done | `historic-skies` | History's skies: guest stars of 1006, 1054, 1572 and 1604, Julian dates before 1582, a Moments library and 'the sky you were born under' ★ | 4 | M | 0d6f438 (Julian calendar before 1582, guest stars 1006–1604, Moments library, 'sky you were born under'). |
| done | `analemma-sun-path` | Analemma and Sun-path diagram in sky view, plus the subsolar figure-8 on the globe | 3 | M | 612b08e (layer 'y': today/solstice/equinox paths, noon analemma, subsolar figure-8). |
| done | `visibility-year-planner` | 'Best time to observe X': a 12-month planet visibility chart | 3 | M | 612b08e (body-card 12-month chart, text mode). |
| done | `meteor-showers` | Meteor showers: radiants, peak events with Moon interference, and live meteors in sky view ★ | 3 | L | 612b08e (13 IMO showers with validity years, radiants, live meteors medium+, layer 'w'). |
| done | `star-info-light-time` | Tap any star: name, Bayer designation, distance and 'the light you see left in 1476' | 3 | L | 0d6f438 (tap any star: designation, distance, 'the light left in …'). |
| done | `time-machine-sky` | Time-machine sky: star proper motion, pole of date, precession circle and the drifting equinox | 2 | M | 0d6f438 (proper motion, pole of date, precession circle; layer 'r'). |
| done | `deep-sky-objects` | Deep-sky objects: the Messier catalogue and southern showpieces as procedural, true-size sprites ★ | 3 | L | 0d6f438 (110 Messier + 30 showpieces, procedural true-size sprites; layer 'x'). |
| done | `max-deep-stars` | Max tier: deeper star catalogue to about magnitude 8 (d3-celestial stars.8.json, 5.4 MB), lazy-loaded and merged into the GPU arrays | 3 | M | Skipped by the max-tier agent as a detour: needs a build script, lazy decode/merge and a photometry check. 0d6f438 (max only: 36,367 extra Hipparcos stars to V 8.0, data/stars8.json lazy). |
| done | `comets-halley-1066` | Historic and great comets with physical tails: Halley 1066/1456/1910/1986/2061, Hale–Bopp, NEOWISE ★ | 3 | XL | 0d6f438 (Halley 1066/1456/1910/1986/2061 from JPL elements, ion + dust tails). |
| done | `human-emissaries` | Beams to humanity's emissaries: Voyager 1 and 2, New Horizons and JWST, with 'a message sent now arrives tomorrow' | 4 | L | 0d6f438 (Voyager 1/2, New Horizons, JWST radio beams, light time, DSN station; layer 'v'). |
| done | `live-satellites` | The ISS and bright satellites: a beam that visibly moves at 1x, with real pass predictions ★ | 4 | L | 5dac108 (ISS, Tiangong, HST + 3 bright stages; SGP4 vs Vallado vectors; passes list + Watch; TLEs refreshed at deploy, layer 'i'). |
| done | `stand-on-mars` | Stand on Mars: a Mars observer with a butterscotch day, a blue sunset and Earth as the evening star ★ | 4 | XL | 865c9af (phase 1: sky view from Jezero; Mars clock in sols/LMST; Phobos/Deimos as 'moon:' extras; Earth + Moon as the evening star; host=mars). Phase 2 (globe/almanac on Mars) not done. |

## Phase 7: Interface, performance & engineering

| Status | ID | Item | Impact | Effort | Notes |
|---|---|---|---|---|---|
| todo | `tonight-planner` | Tonight planner: a dusk-to-dawn visibility chart, with countdowns and sparklines in Sky now | 3 | M |  |
| todo | `sky-dome-chart` | All-sky dome chart: a live planisphere at the top of Sky now and the hero of text mode ★ | 3 | M |  |
| todo | `event-glyphs-and-ics` | Event glyphs that show the event, and 'Add to calendar' (.ics) offline | 2 | S |  |
| todo | `first-run-touch-onboarding` | Touch-aware first run: gesture tips, a 3-step coach mark, an intro caption and an Install button | 3 | M |  |
| todo | `night-vision-mode` | Night-vision red mode with a screen wake lock for real observing | 2 | S |  |
| todo | `sky-ribbon-scrubber` | Sky-ribbon scrubber: true sky colours, Moon and selected-body bands, fling and haptics | 2 | M |  |
| todo | `picker-place-preview` | Location picker that previews each place's sky: local time, day or night, Moon up | 2 | S |  |
| todo | `i18n-a11y-readiness` | i18n and accessibility readiness: a string table, Intl-driven dates, Vietnamese first, and contrast and transparency modes | 2 | L |  |
| todo | `instant-earth-progressive-textures` | Instant Earth: 15 KB preview textures, early tier-aware preloads, and a sharpen-in instead of a flat blue ball ★ | 3 | L |  |
| todo | `boot-critical-path-diet` | Boot diet: remove about 0.6 s of main-thread blocking behind the loader (GL probe, a 399 ms upload, shader-error readbacks, per-chunk redraws) | 2 | S |  |
| todo | `sw-atomic-updates-offline-ci` | Service worker 2.0: content-hashed versions, atomic precache, a 'new version ready' toast, and an offline-reload smoke test in CI | 3 | M |  |
| todo | `regression-gates-ci` | Visual-regression goldens and performance budgets in CI, using the zero-dependency PNG decoder the repo already has | 3 | M |  |
| todo | `hitch-free-tier-switch` | Hitch-free tier switches: compile the next tier's shader variants and upload its textures before swapping | 3 | M |  |
| todo | `context-loss-backoff-and-diagnostics` | Memory-pressure-aware context-loss recovery, warning-free restore, and a 'Copy diagnostics' button | 2 | S |  |
| todo | `ktx2-gpu-compressed-textures` | GPU-compressed textures (KTX2/Basis, vendored from three r170): about 6-8x less VRAM, no upload freezes, fewer context losses on phones ★ | 2 | L |  |
| done | `max-tier` | Max quality tier: manual, no size budget (8K Earth day/night/clouds, 4K Moon, full DPR, max MSAA/anisotropy, full-res bloom) ★ | 4 | M | Owner request 2026-11-04. Merge after fd4dbbc. Heavy future effects belong on max. |

## Dropped at review

- `true-light-time-pulses`: Light-time pulses that mean something: true speed of light on the Moon beam, distance-coded elsewhere (rejected by the verifier; see IDEAS.md).

## Log

- 2026-11-03: Review run; tracker created.
- 2026-11-04: Phase 0 complete (22 items). Seven worktree groups, each reviewed; three blocking findings fixed
  (Moon framing on phones, governor stall votes, low-tier islands). Merged into v2.1-breathtaking: npm test (457), size,
  smoke, smoke:mobile, text mode and vendor --check pass. Totality star gating unified on exposure.stars. Minor follow-ups
  from review, not yet done: a lunar-eclipse jump lands mid-eclipse when the Moon is up only near U1/U4; partial solar
  eclipse titles still quote the peak obscuration when the peak is below the horizon; the keyboard help still says
  'Equatorial grid'; 375 px phones can clip the date by 2–3 px while 'Timelapse' shows; the daytime label style also
  applies to trail month ticks. graphify not yet rebuilt.
- 2026-11-04: Phase 1 (Eclipse 2027) complete: foundation and totality visuals in parallel, then path render/chase and
  the companion HUD (≤ 3 agents at a time). Merged at 5f2e302; npm test (511), size, smoke, smoke:mobile and text mode pass.
  Tier budgets raised to low 3.5 / medium 4.35 / high 5.55 MB (about 130 KB of new JS); headroom is now ~30–60 KB per tier,
  so Phase 2+ needs either lazy loading or another re-baseline.
- 2026-11-04: Eclipse review (Phase 0 core + Phase 1): contacts match AE within 5 ms, paths within ~2 % of NASA. Fixed
  9784110 (chase focus kind) and the chase's leftover timelapse range + ribbon retry after a failed request. Open minor items:
  Play/reverse during the chase's 1.5 s hold at greatest eclipse; event contact times are shown in the observer's zone and
  don't refresh on a 12/24 h toggle (same as 'tonight'); the brown lunar disc at the diamond ring is bloom (by design).
- 2026-11-04: Max quality tier merged (owner request): manual only, pinned against the governor, no size budget (max is
  ~20.7 MB; staged-site budget raised 12 → 32 MB). low/medium/high budgets unchanged. CLAUDE.md updated (four tiers).
- 2026-11-04: Phase 2 (Sky view 2.0) merged: landscape + twilight ground + refraction (a64d96d) and night-sky brightness,
  vision, zodiacal light, scintillation, procedural flare (94afa61). npm test (552), size, smoke, smoke:mobile, text mode pass.
  Budgets now low 3.6 / medium 4.4 / high 5.6 MB. physical-sky-lut deferred in favour of Phases 3–4.
- 2026-11-05: Phases 3 (planet shader, Galilean moons, eyepiece card) and 4 (aurora, moonlight, close-zoom lights,
  sculpted clouds) merged at da679f0; npm test (584), size, smoke, smoke:mobile, text mode pass. Budgets low 3.72 / medium 4.47 /
  high 5.7 MB — high is near the spec's 6 MB hard line, so new code should lean on lazy loading. The telescope agent hit
  the usage limit with no work saved; restarted from da679f0.
- 2026-11-05: Telescope/tracking merged at 828f82a; npm test (594), size, smoke, smoke:mobile, text mode pass. Budgets low 3.76 /
  medium 4.52 / high 5.73 MB (high has ~3 KB headroom under its budget, 0.27 MB under the 6 MB hard line).
- 2026-11-05: Review of Phases 2–4 + max (3 lens reviewers, 1 fixer): 14 findings, 3 blocking; 12 fixed (46b4515 aurora
  limb shell miss test, 76b74a8 star-lock at the pole, 858cb40 zodiacal light from Leinert Table 17, plus 9 minor fixes up to
  f0545b2); npm test (600), size, smoke, smoke:mobile pass. Open follow-ups: (1) Auto Bortle under-estimates rural towns —
  cities.json has only 1,621 large cities; needs a light-pollution raster or a denser town list (max-only data is fine);
  (2) leaving max keeps the 8K maps on the GPU — needs a texture-store release() and rebinding. High tier has ~1.4 KB of
  budget headroom and is 0.27 MB under the 6 MB hard line: new features should lazy-load or live on max.
- 2026-11-05: graphify code graph rebuilt (3662dc1, AST only: 2,502 nodes, 101 communities). Doc semantics pending: run
  /graphify . --update (LLM) when convenient. Next up: Phase 5 (camera, storytelling & sharing) — lazy-load new UI/render
  code (high tier is at its 6 MB ceiling), starting with lighten-stacking-exposure, sky-postcard and guided-tours.
- 2026-11-05: Owner raised the high tier's limit to 8 MB (budget and hard line); low and medium keep their budgets and the
  6 MB line. Shared JS still counts on every tier, so new code raises low/medium budgets deliberately per feature.
- 2026-11-05: Phase 5 batch 1 merged at b57fde1 (capture, tours, vantage); npm test (647), size, smoke, smoke:mobile, text
  mode pass. Budgets low 4.0 / medium 4.76 MB (high 5.92 of 8). main.js now has one drawnLayers(state) for both the vantage
  and long-exposure layer rules.
- 2026-11-05: Phase 5 batch 2 — skyi, quality and views merged at a6d1e37 (npm test 702, size, smoke, smoke:mobile, text mode pass;
  low 4.20 / medium 4.96 / high 6.18 MB). The orrery branch conflicted in 17 files with the map/aiming/recorder work, so
  its merge was aborted and handed to a single integration agent (wip/p5-orrery-merged from a6d1e37).
- 2026-11-05: Orrery integrated and merged at f2087a9; npm test (720), size, smoke, smoke:mobile, text mode pass. Budgets low
  4.41 / medium 5.19 / high 8 MB (measured 4.30 / 5.05 / 6.27). Phase 5 review next.
- 2026-11-05: Phase 5 review (3 lens reviewers + 1 fixer): 16 findings (9 blocking), all fixed in 50633c0..e6ed0cf —
  idle supersampling now idles under Earth-lock, exposure resets on view-offset changes, orrery Esc/Globe at 110–150 R,
  orrery labels/picking on phones, Moon orbit re-sampling, tours restore map/system/vantage and own their Esc, Show both
  beams stays on the globe, mobile HUD stacking, live system links hold direction, Sun crossfade. npm test (732), size,
  smoke, smoke:mobile, text mode pass. Code graph rebuilt (3,149 nodes). Remaining: Phases 6–7, the deferred items
  (physical-sky-lut, ozone-twilight-limb, sky-soundscape, max-deep-stars, Auto Bortle data, max texture release).
- 2026-11-05: Phase 6 batch 1 merged (0d6f438 history+deep, 612b08e events): general extra-object selection model (star:/dso:/
  comet:/craft:/guest:), 11 items. npm test (814), size, smoke, smoke:mobile, text mode pass. Layer-code clash resolved:
  precession 'r', meteors 'w' (default ly=bgoscCnmkazhldxw). Budgets low 4.8 / medium 5.59 MB (medium measured 5.44 —
  ~0.5 MB left under its 6 MB line). Batch 2 (live-satellites, stand-on-mars) next, then the Phase 6 review and a PR.
- 2026-11-05: Phase 6 batch 2 merged (5dac108 satellites, 865c9af Mars). Selection-kind clash resolved: Earth satellites 'sat:',
  Mars's moons 'moon:'; satellites are host 'earth' (hidden from Mars). npm test (839), size, smoke, smoke:mobile, text mode
  pass. Budgets low 5.0 / medium 5.79 MB (measured 4.86 / 5.62 — medium has ~0.38 MB under its 6 MB line). Note: pages.yml
  now also deploys on a daily schedule to refresh satellite elements.
