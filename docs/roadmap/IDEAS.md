# Roadmap ideas: verified details

Generated from the November 2026 review. Each entry: the reviewer's proposal, then the verifier's
verdict, evidence and corrections. **Corrections override the proposal.** Line numbers refer to
commit `cd38985` and drift as the code changes. Status lives in [../ROADMAP.md](../ROADMAP.md).

## Lens: Globe photorealism

The globe is already well engineered. One single-scattering atmosphere model is shared by the limb, the surface haze and the clouds. The ocean glint uses two GGX lobes, eclipse shadows are computed per fragment, there are high-tier cloud shadows and bump, and the bloom is protected against NaN. There is plenty of GPU headroom: a high-tier frame at 2880x1800 measured 3.3 ms on this discrete GPU, of which the clouds are about 0.85 ms and the atmosphere shell about 0.43 ms. The weak points are clear. Close zoom falls apart: from 510 km the screen is about 0.7 km/px against 9.8 km texels, so city lights become bilinear squares and clouds become blobs. The clouds are a flat alpha decal with no relief, phase function or self-shadow. The night side never changes: there is no aurora, and the moonlight is a constant. There are a few real defects: the umbra is drawn about 19% too narrow, medium and high show different weather, and phones get no anti-aliasing. The biggest opportunity needs no new assets: sculpted, self-shadowed clouds with silver linings plus a physically placed aurora oval would make the planet look volumetric and alive. After that, the about 5.5 MB of staging headroom can go to either seasonal Blue Marble surfaces or close-zoom detail tiles, but not both unless the 12 MB budget is raised.

### `sculpted-clouds`: Sculpted clouds: relief, self-shadow, thickness and silver linings from the existing cloud map ★

*visual · impact 5→4 · effort M→M · verdict **keep***

**Pitch.** Near the terminator, cloud fields become 3D landscapes: storm towers lit gold on one side, long shadows across lower decks, thin wisps going grey over dark ocean, and a silver rim on clouds backlit at the limb. This is the look of an ISS photo, and it needs zero new bytes.

**Current state.** clouds.glsl.js:60-63 lights every cloud pixel with sunC*wrapL(mu)*0.9. That depends only on the geometric sphere normal. Density only drives alpha (clouds.glsl.js:84-86), so a thin wisp and a thick anvil are equally bright and have no relief. There is no phase function, so clouds near the sunrise limb in globe-backlit.png stay flat. Cloud shadows fall only on the ground (earth.glsl.js:189-200, high tier). Close up (globe-eclipse-close.png, globe-terminator-1p12.png) cloud edges are soft blobs.

**Proposal.** All changes are in clouds.glsl.js after cloudAt().
(1) Relief normal. Treat density as a height field h = d*H (H about 0.004 ER). Take central differences on mip 1-2 (brc4k: 4 taps of textureLod(lod+1); clouds1k: reuse the pcTextureBSpline taps). Build Nc = normalize(Ng - k*(dh/de*eW + dh/dn*nW)) with the pole-robust tangent frame already in earth.glsl.js:156-159, then light with wrap(Nc.L).
(2) Self-shadow, high only. March 4 taps toward the Sun in uv using the CLOUD_SHADOWS offset math (step about 0.002/max(mu,0.05) ER). The pixel is shadowed where d(sample)*H > h + t*tan(sunAlt); use visibility = exp(-k * sum of excess) so long shadows stretch across decks at low Sun.
(3) Beer-powder albedo: (1-exp(-tau))*(1-0.5*exp(-2*tau)) with tau = 8d. Thin cloud reads grey over ocean and cores read white.
(4) Phase: mix(isotropic, HG(g=0.6, nu=dot(-V,L)), 0.5), under the existing soft cap, for silver linings when the Sun is behind the limb.
(5) Sub-texel erosion when lod < 0: alpha = saturate((d - n*0.3*(1-d))/0.7), with 2-octave value noise built from hash12 (common.glsl.js:91-95) at 8x texel frequency in Earth-fixed coordinates. Edges get crisp at close zoom.
Keep earth.glsl's cloudAt identical so ground shadows stay registered.
Tiers: high gets all five; medium gets 1, 3, 4 and 5 (no march); low has no clouds. Text mode is unaffected. Size: 0 bytes. Expected cost on high: +0.5 to 1.0 ms at 2880x1800, against the measured 0.85 ms the clouds cost today.

**Risks.** The brc4k blue channel is 8-bit JPEG, so gradients are noisy: take them on mip 1-2 and clamp. Height-from-density is a heuristic (it treats thin cirrus as low cloud). On medium integrated GPUs the normal costs 4-6 more fetches per cloud pixel, so gate it by lod. Uniforms only, so R5 holds. The shader must keep the tonemapping and colorspace includes.

**Files.** `js/render/shaders/clouds.glsl.js`, `js/render/shaders/earth.glsl.js`, `js/render/earth.js`

**Verifier evidence.** clouds.glsl.js:60-63: lighting is atmSunTint(CLOUD_TOP,mu)*wrapL(mu)*uSunE*0.9*sunVis. It depends only on the geometric normal Ng. Density only sets alpha (clouds.glsl.js:85-86). A grep finds no phase function, relief, Beer, powder, silver-lining or erosion code anywhere in js/. Ground cloud shadows exist only under #ifdef CLOUD_SHADOWS (earth.glsl.js:189-200, high). cloudAt mode 2 (brc4k, high) is a plain texture().b with smoothstep (earth.glsl.js:81). Mode 1 (clouds1k, medium) uses pcTextureBSpline only when magnified (earth.glsl.js:74-79). globe-terminator.png and globe-terminator-close.png confirm flat, uniformly lit cloud decks and soft-blob edges near the terminator. All proposed changes need uniforms or ALU only, so R5 and the shader includes are unaffected. Size cost is 0.

**Verifier corrections.** (a) The clouds1k gradient cannot reuse the pcTextureBSpline taps: those 4 bilinear taps return one filtered value, not derivatives. Use 4 more taps on mip lod+1. A zero-fetch alternative for medium is a surface-gradient bump (Mikkelsen 2010) from dFdx/dFdy of the density and of vPosW, which is smooth when magnified because the B-spline result is C2. (b) Mode 2 (high) computes no lod today, so step (5)'s lod<0 gate needs the same lod computation that mode 1 already has. (c) Lower expectations: brc4k texels are 9.8 km, so at home distance 3.4 the relief is 1-3 px of extra shading in the terminator band. It makes the clouds look textured, not an ISS-photo landscape. Impact is 4, not 5.

### `aurora-oval`: Physically placed auroral ovals with volumetric curtains ★

*feature · impact 5→4 · effort L→L · verdict **revise***

**Pitch.** Spin to the night side over Canada, Scandinavia or Antarctica and a green ring hangs over the pole, crowned with red and rippling while time runs. It sits where the real oval sits for that UTC and season, so it is a wow shot that still respects the app's accuracy ethos.

**Current state.** There is no aurora anywhere: a grep for 'aurora' over js/ returns nothing. The night side gets city lights (earth.glsl.js:229-234), a constant fill (earth.glsl.js:211-213) and a 7 km airglow line (atmosphere.glsl.js:165-166, 231-239) that is sub-pixel at every reachable framing.

**Proposal.** Pure astronomy: a new js/astro/geomag.js.
- IGRF-14 dipole terms (g10, g11, h11 plus secular variation) give a pole near 80.8N 72.7W in 2025. Output the dipole axis in the Earth-fixed frame.
- Feldstein-Starkov (2001) oval boundaries: Fourier series in MLT with Kp-linear coefficients (about 30 numbers). Each snapshot fills a preallocated Float32Array(48) of equatorward and poleward geomagnetic latitudes at 24 MLT bins.

Render: new js/render/aurora.js and shaders/aurora.glsl.js.
- BackSide shell at r = 1.05, additive, renderOrder 15 (between clouds 10 and atmosphere 20), depthTest on so the Earth occludes it.
- Intersect the view ray with shells 1.016 to 1.047 (100-300 km real altitude). March 16 samples on high and 8 on medium.
- Emission = oval mask(magLat, MLT) x curtain(magLon, simTime) x altitude profile. MLT comes from the Sun projected perpendicular to the dipole, using uniforms from earth.js. The profile is 557.7 nm green peaking at 110-150 km, 630 nm red at 200-300 km, and a faint 427.8 nm violet bottom fringe at high Kp.
- Curtains: domain-warped 1D fBm along magnetic longitude with folds, plus vertical ray striations. They drift only with simulated time, so a paused app stays render-on-demand.
- Fade on the dayside with smoothstep on mu.

Low tier: no shell; earth.glsl.js adds a 2D surface glow band from the same table (about 10 ALU).

State and UI:
- Layer letter 'u' in url-state.js:19-24, default on, plus the store default.
- Kp setting 1-9 (default 3) in Settings, persisted through core/prefs.
- Register the module in importRenderStack() and the create list in main.js.
- Text mode: one Details line, computed in pure code: 'Typical oval (Kp 3) reaches ~6x deg geomagnetic latitude'.

Size: about 10 KB of JS and GLSL, which fits even the low tier's 90 KB headroom (3.71/3.80 MB).

**Risks.** It is not live. Offline-first and the rule against external URLs outside geocode.js both forbid fetching NOAA Kp, so the UI must say 'typical/selected activity', not a forecast. IGRF is only valid 1900-2030 while the clock spans 1000-3000: clamp to the nearest epoch and document it in ASTRONOMY.md. Animation must follow simulated time only, or the idle app redraws forever. Keep emission under the 0.9 bloom threshold except at high Kp. Needs a shader-include and module-registration test.

**Files.** `js/astro/geomag.js`, `js/render/aurora.js`, `js/render/shaders/aurora.glsl.js`, `js/render/earth.js`, `js/render/shaders/earth.glsl.js`, `js/core/url-state.js`, `js/core/store.js`, `js/main.js`

**Verifier evidence.** grep 'aurora' over js/, docs/ and scripts/ finds nothing. Layer letter 'u' is unused in LAYER_CODES (url-state.js:19-24). The airglow is AG_W = 0.0011 ER (atmosphere.glsl.js:165-166, 231-239). check-size: low 3.71/3.80 MB, so about 10 KB of JS fits. The architecture problem: atmosphere.glsl.js:13-17 documents that a BackSide shell with depthTest 'pixels covered by the Earth fail the depth test'. The proposed BackSide, depth-tested aurora shell therefore only draws where the far side of the shell is not behind the planet. The face-on oval over the night-side disc, the pitch's main shot, would be depth-rejected. The loop (loop.js:310-312) only animates continuously for twinkle, camera and time-lapse, so at Live rate snapshot-driven curtains would step at the 0.5 s snapshot cadence.

**Verifier corrections.** Draw the face-on oval in the surface and cloud shaders, the same way the atmosphere uses aerial perspective. It is a cheap emission term from the 48-float boundary table, and it covers the low tier too. Keep a volumetric shell only for the limb curtains. Make that shell FrontSide (near hemisphere, camera always outside because MIN_DIST is 1.08 > 1.05), march from the entry point to min(exit, planet hit) found analytically, and leave depth test on. Alternatively use depthTest off with in-shader planet clipping. For motion, either ask the loop for continuous frames like twinkle while the oval is on screen, which is reduced-motion aware, or accept static curtains at Live rate. The real-time, uncoupled-from-data aurora is modelled, so impact is 4, not 5. Most observers' home view is mid or low latitude, so add an Events entry or a 'fly to oval' preset to make it discoverable.

### `eclipse-shadow-story`: Make the Moon's shadow legible: path of totality, limb-darkened penumbra, umbral twilight ★

*feature · impact 4→4 · effort M→L · verdict **keep** · tracked under `eclipse-path-of-totality`*

**Pitch.** Jump to an eclipse and you see a DSCOVR-style shot: a bronze-black umbra racing along a glowing ribbon of the path of totality, ringed by a penumbra that deepens and warms toward the centre. Today the shadow is about 10 px and hidden under the pin.

**Current state.** Per-fragment umbra and penumbra already exist (earth.glsl.js:181-187, clouds.glsl.js:53-58, atmosphere.glsl.js:173-178). At the eclipse-jump framing (actions.js:575, distance 2.6) and at the home view (eclipse-luxor.png) the umbra is about 10 px and covered by the pin rings. It is only obvious with labels off and zoomed in (globe-eclipse-noui.png), and it renders as a neutral grey-black hole. There is no track of totality: only events.js:241 text mentions it, and nothing in js/astro computes a path.

**Proposal.** (a) Pure eclipsePath(peakMs, out) in js/astro/shadow.js, run in the existing astro worker. Every 60 s over ±2.5 h, take the axis-Earth intersection (the same algebra as actions.js:181-197 shadowPoint). Find the northern and southern limits by bisection on solarObscurationAt (shadow.js:157) along the perpendicular. Write into a preallocated Float64Array(3x3x300).
(b) New js/render/eclipsepath.js: a ribbon BufferGeometry built once per eclipse (R5 forbids per-frame allocation, not per-event), Earth-fixed and parented in the earth group at r = 1.0008. Additive shader: a thin gold centre line and a translucent band between the limits; the labels feed adds 30-minute tick labels. Shown while snap.eclipse.solar is set, or within ±1 day of an eclipse picked in the Events panel. Draw the antumbra band for annular and hybrid eclipses.
(c) Rendering-only discVisibleLD: a few quadrature taps over the visible crescent, weighted by limb darkening I(mu) = 1 - u(1-mu) with u about (0.55, 0.65, 0.80) for RGB. The inner penumbra then darkens faster and warms. shadow.js stays area-based so the panel keeps the standard obscuration definition.
(d) Umbral twilight: inside the umbra add (1-sunVis)^2 * atmSunTint(0, -0.02) * 2e-3, so the core reads as a dark bronze bruise as in astronaut and DSCOVR imagery, not a grey hole.
(e) The eclipse jump flies to distance 1.6, and the pin rings fade while obscuration under the pin is above 0.9.
Tiers: low gets the ribbon only. Text mode: none (the Events text already describes it). Size: about 8 KB.

**Risks.** The path costs about 300 x 20 bisection steps of solarObscurationAt, a few ms in the worker. The ribbon must handle dateline and polar crossings, which is easy if built in Earth-fixed coordinates. Because the rendered limb-darkened visibility differs from the panel's area obscuration, document both in ASTRONOMY.md. The common.glsl.js discVisible comment says it mirrors shadow.js, so add a new function rather than changing that one.

**Files.** `js/astro/shadow.js`, `js/astro/worker.js`, `js/render/eclipsepath.js`, `js/render/shaders/earth.glsl.js`, `js/render/shaders/common.glsl.js`, `js/render/pin.js`, `js/app/actions.js`, `js/main.js`

**Verifier evidence.** Per-fragment shadow exists: earth.glsl.js:181-187, clouds.glsl.js:53-58, atmosphere.glsl.js:173-178. events.js:241 is text only. grep for eclipsePath, 'path of totality' and centerline in js/ finds nothing. The eclipse jump flies to distance 2.6 (actions.js:575). I took my own shot, globeverify-eclipse-jump.png (high, sel=sun, cam o:25.7,32.6,2.6, 2027-08-02T10:07Z). The penumbra is only a faint darkening and the Nile lights switching on. The umbra itself is hidden under the pin and beam convergence at Luxor. globe-eclipse-noui.png and camera-umbra-chase.png show the shadow as a neutral grey-black smudge once zoomed in with no UI.

**Verifier corrections.** (1) Do not put eclipsePath in shadow.js. That module is AE-free pure geometry; the path needs AE.GeoMoon, the Sun vector and Earth rotation per step. Use a new pure js/astro/eclipsepath.js, exposed as a worker op next to 'path'. (2) The cloud shell sits at r=1.006 with renderOrder 10 and depthWrite off. A ribbon at r=1.0008 drawn before it would be hidden under cloud. Give it renderOrder above 10 and depth-test only against the Earth so the track stays legible. (3) Effort is L, not M: a new render module registered in main.js, a worker op, label ticks via labels-feed, three shader edits and tests. (4) Part (c), limb darkening, adds per-fragment quadrature in three shaders for a subtle gain. Do it last.

### `close-zoom-lights`: Close-zoom city lights: bicubic filter, sub-texel light grain, restored highlights

*visual · impact 4→3 · effort S→S · verdict **keep***

**Pitch.** Zoom down to 500 km over Europe at night and the cities resolve into strings of streetlights and highway beads that ripple on across the terminator during time-lapse. Today they are blurry orange squares.

**Current state.** earth.glsl.js:233 samples the 4k night map with plain bilinear texture(uNight, uv). At distances 1.08-1.3 each 9.8 km texel spans 10-14 px, so lights render as squares with linear creases. A column profile of globe-terminator-1p12.png shows piecewise-linear 9-10 px ramps with kinks (crop: globe-crop-lights.png). The clouds already solved this with pcTextureBSpline (earth.glsl.js:54-67, mip blend at 74-80), but the night map never got it. An in-browser scan found 2,887 of the 62,725 lit texels (4.6%) clipped at 255, so every metropolis core is the same flat plateau.

**Proposal.** (1) Generalise the lod blend in cloudAt into magSample(tex, uv), which takes the 4-tap B-spline only when lod < 0. Use it for uNight (earth.glsl.js:233 and clouds.glsl.js:71), and on high for the day map too.
(2) When lod < -1, multiply by an energy-conserving point field. Cells sit at 4x texel frequency in Earth-fixed uv, with one hash12-jittered point per cell and weight = texel/mean, so each cell's average equals the texel. Gaussian radius = max(1.2 px from fwidth, 0.15 cell), blended in by smoothstep(-1, -3, lod) so far views are untouched.
(3) Pseudo-HDR core expansion: lights *= 1 + 3*smoothstep(0.85, 1.0, maxc), so clipped cores bloom harder than suburbs.
(4) Per-cell hash jitter (±0.015 in mu) on the nightW thresholds (earth.glsl.js:230), so lights switch on progressively across the terminator in time-lapse.
Tiers: all; low gets (1) only. Size: 0 bytes. Text mode: n/a.

**Risks.** The grain is invented sub-texel detail: plausible, not data, so keep it subtle. It must be Earth-fixed and lod-faded, or it shimmers while orbiting. It adds 3-4 fetches at close zoom only, which matters slightly on medium phones.

**Files.** `js/render/shaders/earth.glsl.js`, `js/render/shaders/clouds.glsl.js`

**Verifier evidence.** earth.glsl.js:233 samples uNight with plain texture() and the texture's magFilter is Linear (textures.js:229). globe-terminator-1p12.png and globe-terminator-close.png show city lights as hard-edged blurry squares at close zoom. I reproduced the clipped-texel claim with an in-browser scan of earth_night_4096.jpg (4096x2048): 2,887 texels have max channel >= 250, which matches the proposal exactly. pcTextureBSpline already exists in CLOUD_LOOKUP (earth.glsl.js:54-67) and is shared into earth.glsl, so generalising it costs 0 bytes.

**Verifier corrections.** The clouds.glsl.js:71 night lookup is deliberately textureLod(uNight, uv, 3.5), heavily blurred because clouds diffuse the light. A magnification-only B-spline does nothing there, so change earth.glsl.js only. The sub-texel point field (step 2) is invented detail; gate it hard by lod so far views do not sparkle. Impact is 3: the gain shows only below about distance 1.5, though zooming into your own city at night is a common action.

### `umbra-radius-bug`: Bug: the globe's umbra is drawn ~19% too narrow (constant solar radius in two shaders)

*bug · impact 3→2 · effort S→S · verdict **keep***

**Pitch.** The Moon's shadow on the globe will have the correct size and match the panel's obscuration. Today the panel is right and the picture is wrong.

**Current state.** earth.js:20 and atmosphere.js:13 hard-code SUN_ANG_RADIUS_RAD = 0.0046542 into uEclipse.z (earth.js:116, atmosphere.js:51), and apply() never updates it (earth.js:296-298, atmosphere.js:87-93). The panel uses the true value asin(R/d) (snapshot.js:336), and render/bodies.js:358 already divides by sunDistAU.

Repro (node probe on js/astro, solarObscurationAt along a tangent from the axis point) at 2027-08-02T10:07Z:
- The Sun is at 1.01487 AU, so its true angular radius is 0.0045843 rad and the constant is 1.5% too large.
- Umbra half-width: 105 km rendered vs 129 km true (-19%).
- Near perihelion (the 2027-02-06 annular, 0.98611 AU) the constant is 1.4% too small, so the antumbra is drawn too large.
- In hybrid eclipses the globe can show the wrong kind (total vs annular) near the path ends.

**Proposal.** In earth.js apply() and atmosphere.js apply(), set uEclipse.value.z = Math.asin(696000 / (snap.bodies[0].distAU * 1.495978707e8)). distAU is computed at every detail level (snapshot.js:250), and the rule matches snapshot.js:336. Rename the constant in js/astro/bodies.js:21 to make clear it is the mean at 1 AU. Add a test that the uniform equals the argument snapshot.js passes to solarObscurationAt for a sample date. Size: 0. All tiers.

**Risks.** None of note. Existing eclipse screenshots and baselines shift slightly.

**Files.** `js/render/earth.js`, `js/render/atmosphere.js`, `js/astro/bodies.js`

**Verifier evidence.** Confirmed: earth.js:20 and atmosphere.js:13 hard-code SUN_ANG_RADIUS_RAD = 0.0046542 (960 arcsec) into uEclipse.z (earth.js:116, atmosphere.js:51). apply() never touches .z (earth.js:298, atmosphere.js:92). The panel passes asin(SUN_RADIUS_KM/(distAU*AU_KM)) with SUN_RADIUS_KM = BODIES[0].radiusKm = 695700 (snapshot.js:44, 336). My node probe (computeSnapshot plus solarObscurationAt along the perpendicular through the axis point): at 2027-08-02T10:07Z, distAU 1.01487, true radius 0.0045824 rad, constant 1.57% too large. Umbra half-width is 103.6 km with the constant and 128.8 km true (-19.6%). At 2027-02-06T16:00Z (distAU 0.98614), central obscuration is 0.886 with the constant vs 0.863 true. The shaders' common.glsl.js discVisible says it mirrors shadow.js, so the mismatch contradicts the documented contract.

**Verifier corrections.** Use 695700 km (BODIES[0].radiusKm), not 696000, so the uniform equals what snapshot.js:336 passes. Better, export one helper from js/astro/bodies.js, e.g. sunAngularRadius(distAU), and use it in snapshot.js, earth.js, atmosphere.js, render/bodies.js:358 and flare.js:147. Those last two use 960 arcsec/distAU, which is 0.08% off. The cloud material shares u.uEclipse by reference (earth.js:143), so updating earth.js fixes the clouds as well. Impact is 2: about 25 km of radius is 1-3 px at normal framings. It is still a real correctness bug in an accuracy-first app.

### `orbital-horizon-view`: Orbital horizon view (ISS cupola mode): tilt the camera at low altitude ★

*feature · impact 4→4 · effort L→L · verdict **keep***

**Pitch.** From 400 km, tilt up to the horizon. You see a thin layered limb glowing over the terminator, a green airglow line above the night side, cloud shadows streaming toward sunset and cities under the haze. The atmosphere model already computes all of it, but no camera can reach the view.

**Current state.** The orbit camera always looks at the Earth's centre: rig.js uses OrbitControls with target 0, MIN_DIST is 1.08 (rig.js:49), and the hash only carries cam=o:lat,lon,dist (url-state.js:29). The airglow layer (AG_W = 0.0011 ER, about 7 km; atmosphere.glsl.js:165-166) is sub-pixel at every reachable framing and invisible even in the backlit shot (globe-backlit.png, globe-crop-limb.png).

**Proposal.** Camera:
- Below dist 1.8, a right-drag, two-finger vertical drag, or [ and ] keys pitch the camera about the surface point beneath it, from nadir to about 85 degrees (Google-Earth style). The OrbitControls target moves to that surface point so orbiting still works.
- Extend the hash back-compatibly to cam=o:lat,lon,dist,tilt,heading.
- Add an 'ISS' preset (408 km, tilt 75, heading toward the terminator).

Shaders:
- Expose the atmosphere's 5x inflation (ATM_HR/HM/BETA constants, atmosphere.glsl.js:39-46) as a uInflate uniform shared by the shell, surface and clouds. Ease it toward about 2x when tilt is above 60 degrees, so the limb band keeps a believable thickness.
- Airglow width = max(AG_W, 1.2 x pixel footprint), with amplitude scaled by AG_W/width to conserve energy, so it reads as a fine stable line.
- Verify the cloud silhouette fade (clouds.glsl.js:87-93) and FAR_FADE (atmosphere.glsl.js:171) with the camera at 1.08.

Picking (camera/picking.js) and the beam label anchors must accept a non-centred target. Fly-to and intro tweens reset tilt to 0. Reduced motion turns tilt into a cut. All tiers; low keeps the analytic atmosphere. Size: about 5 KB.

**Risks.** The limb-to-disc colour match relies on identical constants in three shaders, so the inflation must become one shared uniform or the seam returns. Labels and beams were designed for a centre-looking camera. Check depth precision at grazing angles with near = 0.01. This is partly a camera feature (overlaps the camera lens), but it is the stage that makes the globe-photorealism work visible.

**Files.** `js/camera/rig.js`, `js/camera/picking.js`, `js/core/url-state.js`, `js/render/shaders/atmosphere.glsl.js`, `js/render/atmosphere.js`, `js/render/shaders/earth.glsl.js`, `js/render/shaders/clouds.glsl.js`

**Verifier evidence.** rig.js:185-193: OrbitControls has enablePan=false, target always (0,0,0) (also rig.js:271), and MIN_DIST is 1.08 (rig.js:49). The cam hash is only o:lat,lon,dist (url-state.js:29, 196). grep for tilt/pitch finds only the sky-view descent pitch (rig.js:466-498). At distance 1.08 the limb is 67.8 deg off-axis, outside the 22.5 deg half-FOV. At distance 3.4 the 7 km airglow (AG_W, atmosphere.glsl.js:166) is about 0.4 px. camera-umbra-chase.png, an oblique view another reviewer produced by hand, shows how much better the globe already looks from a grazing angle.

**Verifier corrections.** Picking needs no change: picking.js casts an analytic ray from camera.matrixWorld and projectionMatrixInverse, so any camera orientation already works (picking.js:1-13). Earth-lock rotates camera.position by the Earth's rotation before OrbitControls.update() (rig.js:18-20), so a non-centred target must be rotated by the same quaternion or the camera drifts. A lower-risk design is to keep OrbitControls about the origin and apply tilt and heading as a camera-local rotation after update(), pivoting about the nadir point. Making ATM_HR, ATM_HM and the betas a shared uniform is right, but every consumer of ATMO_MODEL (earth, clouds, atmosphere) must take it in the same commit, or the limb and disc seam returns.

### `seasonal-earth`: Seasonal Earth: NASA Blue Marble monthly surfaces crossfaded by simulated date ★

*feature · impact 4→3 · effort L→L · verdict **revise***

**Pitch.** Scrub the timeline through a year and the planet breathes: snow spreads across Canada and Siberia, the Sahel greens and browns, and the southern hemisphere does the reverse. The globe shows the season of the instant you picked, not one frozen day.

**Current state.** There is a single static day map (textures.js:22-23; earth_day_4096.jpg, Solar System Scope, CC BY 4.0), so snow cover and vegetation never change and July Siberia looks like January. The map's oceans are one flat constant colour (visible in the texture itself).

**Proposal.** Data: NASA Blue Marble Next Generation monthly composites (Stöckli et al., public domain, credit NASA Earth Observatory), resampled to 4096x2048 for 4-6 keyframes (Jan/Mar/May/Jul/Sep/Nov), each about 0.5-0.7 MB JPEG.

Build: new scripts/build-seasons.mjs that decodes, resamples and encodes through the existing headless-Chrome helper (scripts/lib/chrome.mjs), so no npm deps. Pin the sources and sha256 in vendor/VENDOR.json.

Runtime:
- textures.js gets keys day4k_m01... and dayKeyFor(cfg, tMs) returns the bracketing pair.
- earth.glsl.js gets uDay2 and uSeasonMix (one extra sampler on medium and high), blended by day of year.
- The current keyframe is critical; the next is deferred. Dispose the others: each 4k mip chain is about 45 MB of GPU memory.
- Above about 1 week/s of clock rate, freeze the blend so a time-lapse never thrashes loads.
- Refit DERIVED_WINDOW and DAY_GAIN (earth.js:31-33) and LOOK for the new albedo.

Tiers: low keeps the static day2k. Text mode: n/a.

Size: initial per tier about +0 to 0.25 MB; medium has 110 KB headroom, so tune JPEG quality or bump its budget. Staged: +2.5 to 4 MB out of the 5.47 MB headroom (6.53/12 MB).

**Risks.** It competes with detail tiles for the 12 MB staging budget. BMNG is a 2004 climatology, so call it 'typical month', not that year's snow. Check whether the chosen BMNG variant includes sea ice; if not, polar oceans stay static. The brc4k bump and roughness map stays static. The whole palette and the ocean-mask windows need re-tuning.

**Files.** `js/render/textures.js`, `js/render/earth.js`, `js/render/shaders/earth.glsl.js`, `scripts/build-seasons.mjs`, `scripts/check-size.mjs`, `vendor/VENDOR.json`, `README.md`

**Verifier evidence.** Single static day map: textures.js:22 (earth_day_4096.jpg, 473 KB). Viewing the texture confirms a flat uniform ocean colour and a summer-like land surface: no snow over Canada or Siberia, only polar ice. grep for seasonal, BMNG and Blue Marble finds no implementation. Budgets (check-size): medium 4.19/4.30 MB, high 5.24/5.40 MB, staged 6.53/12 MB.

**Verifier corrections.** Main risk: the standard BMNG monthly land composites show no sea ice (the ocean is a uniform or bathymetry fill). Switching would likely turn the winter Arctic and the Southern Ocean ice into open water, a step back from the current map's white caps. Snow is the dominant visible seasonal signal, so a cheaper and safer approach is a monthly snow and sea-ice climatology mask packed into channels: for example 12 months in four 1024x512 RGB images, about 100-200 KB total, deferred. Blend it procedurally over the existing map with the existing ice compression (earth.glsl.js:213). That costs no palette or ocean-mask re-tuning, no second 45 MB 4k sampler on medium phones, and no thrash guard. If BMNG is still wanted, restrict the crossfade to high and composite the sea ice in the build script.

### `moonlight-moonglint`: Real moonlight on the night side, plus a silver moonglint on dark oceans

*visual · impact 3→3 · effort S→S · verdict **keep***

**Pitch.** At full moon the hemisphere facing the Moon is softly lit and a silver glint path lies on the night ocean, a classic astronaut-photo subject. At new moon the night side goes black and the cities pop.

**Current state.** The night fill is a constant 0.008 cool term (earth.glsl.js:211-213), the same at new and full moon and even where the Moon is below the horizon. Clouds do the same (clouds.glsl.js:65-67). The ocean only reflects the Sun (earth.glsl.js:215-227). The snapshot already carries moonPosS (snapshot.js:316-319) and moonPhaseDeg (snapshot.js:324-326).

**Proposal.** earth.js apply():
- uMoonDirW = normalize(moonPosS).
- uMoonK = (1 - cos(phase))/2 x perceptual gain x eclipse.moonLitFraction (so the light drops during a lunar eclipse).

Shader:
- Replace the constant with albedo x max(dot(N, moonDir), 0) x uMoonK x vec3(0.55, 0.75, 1.3) x 0.02, plus a 0.002 starlight floor.
- Moonglint: a second GGX evaluation (sheen lobe only) with moonDir, times uMoonK x 0.4 x ocean x nightW x (1 - cloud).
- The cloud shell gets the same moonlit term.

Tiers: all; low skips the glint. Size: 0 bytes, about 15 ALU.

**Risks.** Physical moonlight is about 4e-6 of sunlight, so the gains are perceptual; document them like the existing 'clearer than life' haze. Keep everything except the glint core under the 0.9 bloom threshold.

**Files.** `js/render/earth.js`, `js/render/shaders/earth.glsl.js`, `js/render/shaders/clouds.glsl.js`

**Verifier evidence.** earth.glsl.js:211-213 adds a constant ...*vec3(0.55,0.75,1.3)*0.008 night fill everywhere, regardless of the Moon's phase or altitude. Clouds do the same (clouds.glsl.js:65-67). The glint uses L only (earth.glsl.js:215-227). snapshot.js:316-319 fills moonPosS. snapshot.js:324-326 sets moonPhaseDeg. ecl.moonLitFraction is set on every detail level (snapshot.js:345-349), so the lunar-eclipse dimming is available.

**Verifier corrections.** No new direction uniform is needed: uMoonPosW is already a uniform in both the earth and cloud materials and is updated every apply() (earth.js:117, 143, 296-297), so use moonDir = normalize(uMoonPosW) in the shader. Add only a scalar uMoonK = illuminated fraction x gain x moonLitFraction. Geometry already handles new and full moon, because the Moon sits over the day side at new moon. Low tier can keep the diffuse term and skip the glint as proposed.

### `living-weather`: Living weather time-lapse: zonal-wind flow-map advection instead of a rigid cloud spin

*feature · impact 4→2 · effort M→M · verdict **revise***

**Pitch.** Run time at a day per second and the weather churns: trade-wind clouds stream west in the tropics while mid-latitude storm systems race east. Today the whole cloud deck slides like a decal.

**Current state.** Clouds rotate rigidly eastward at one lap per 40 days at every latitude (earth.js:35-37, 306-309; the shift is applied in cloudAt at earth.glsl.js:71). Real tropical clouds move west, and the cloud shapes never evolve.

**Proposal.** - Zonal wind profile u(lat): easterlies about -6 m/s at 0-25 deg, westerlies about +12 m/s peaking near 45 deg, polar easterlies. Convert to longitude per day.
- Two-phase flow-map advection (Vlachos 2010): sample at uv - flow*fract(tau) and at uv - flow*fract(tau + 0.5), and blend with triangle weights. With a period of about 1.5 simulated days, shear never accumulates.
- Slow evolution: 3D value noise in (Earth-fixed position, t) modulates density by ±25%.
- Compute tau and the phase fracts on the CPU in float64 (earth.js apply) to avoid float precision loss at large epochs.
- CLOUD_LOOKUP stays shared, so ground shadows, glint masking and light dimming in earth.glsl stay registered.
Tiers: high and medium; low has no clouds. Cost: one extra fetch on high and four extra B-spline taps on medium. Size: 0.

**Risks.** Phase resets can pulse or ghost; offset the phase per region with noise. The base map is still static, so keep the 'illustrative' wording. The motion must stay deterministic in t so URL-shared instants look identical.

**Files.** `js/render/earth.js`, `js/render/shaders/earth.glsl.js`, `js/render/shaders/clouds.glsl.js`

**Verifier evidence.** Rigid drift confirmed: earth.js:35-37 (one lap per 40 days) and earth.js:306-309, applied as a uv.x shift in cloudAt (earth.glsl.js:71). grep for flow-map finds nothing. Numbers: +12 m/s at 45 deg is about 13 deg of longitude per day; -6 m/s at the equator is about -4.9 deg/day.

**Verifier corrections.** The physics fights the technique. With a 1.5-day two-phase flow map, the two blended samples sit flow x 0.75 days apart, about 10 deg at mid-latitudes. Cloud systems are 10-20 deg across, so that produces obvious double images and pulsing at 1 day/s; flow maps hide resets only on noise-like, statistically stationary textures. To stay clean you need about 4x shorter periods or illustrative, reduced speeds, plus per-region phase noise. At that point the visible gain over rigid drift is small, and the base map still never evolves. A cheaper way to make time-lapse feel alive: keep the rigid drift and add slow, deterministic 3D-noise modulation of the coverage threshold (cloudAt density remapping), so systems grow and dissipate. Keep CLOUD_LOOKUP shared so the ground shadows stay registered. Low priority.

### `ozone-twilight-limb`: Ozone absorption in the atmosphere model: the blue band above the orbital sunset

*accuracy · impact 3→2 · effort S→S · verdict **keep***

**Pitch.** The limb at the terminator gets the real orbital-sunset layering: a red-orange base, then yellow, then the deep ozone-blue band that every ISS sunset photo shows. The twilight band on the ground gets the true blue-hour tint.

**Current state.** The model is Rayleigh plus Mie only (atmosphere.glsl.js:39-46 constants, 66-86 sun columns and transmittance) and single scattering, with no ozone. Grazing light therefore goes yellow, orange, red and never produces the Chappuis blue band; globe-crop-limb.png shows orange, then white, then pale blue.

**Proposal.** - Add an ozone tent layer to atmSunColumns, returning a vec4 whose .w is the ozone column.
- Layer centre: 25 km x 5 inflation = 0.0196 ER, half-width 0.0118 ER.
- beta_O3 = (0.650, 1.881, 0.085)e-6 /m for RGB (Hillaire 2020). Scaled like the existing betas (x R_earth / 5) that is about (0.83, 2.40, 0.11) per ER.
- Column: the chord length through the layer from two raySphere calls (COMMON) x 0.5 x peak density.
- Apply it in atmSunTransmittance, atmAerial (atmosphere.glsl.js:117) and the shell loop (atmosphere.glsl.js:218).
Follow-up (separate, L effort): Hillaire 2020 transmittance (256x64) and multi-scattering (32x32) LUTs, rendered once into render targets at boot and on context restore, shared by the shell, surface, clouds and eventually the sky-view dome, unifying the two atmosphere models.
Tiers: all (analytic). Size: about 1 KB.

**Risks.** It shifts the tuned sunset ring and the cloud tint at the terminator, so screenshot baselines must be re-shot. It adds two raySphere calls per shell sample (well under 0.05 ms on high). The LUT follow-up needs render-target lifetime handling on context loss.

**Files.** `js/render/shaders/atmosphere.glsl.js`, `js/render/shaders/earth.glsl.js`, `js/render/shaders/clouds.glsl.js`

**Verifier evidence.** atmosphere.glsl.js:39-46 has Rayleigh and Mie constants only. atmSunColumns returns vec3 (atmosphere.glsl.js:66-80). The only 'ozone' match in js/ is a comment in bodies.glsl.js:173 (the Moon-disc edge colour), not the atmosphere. I checked the proposed coefficient scaling against the existing convention: ATM_BETA_R = (7.4, 17.2, 42.2) equals (5.8, 13.5, 33.1)e-6/m x 6.371e6 / 5, so beta_O3 (0.650, 1.881, 0.085)e-6 x R/5 = (0.83, 2.40, 0.11) per ER is consistent. A grazing path through the layer gives green optical depth of order 1-2, enough to produce the blue band.

**Verifier corrections.** The inflated layer (centre 0.0196, top about 0.0314 ER) extends past ATM_RA = 0.025, so the shell integrates only its lower part. That is acceptable but should be documented. Ground skylight (earth.glsl.js:209) is a hand-tuned constant, so the 'blue-hour tint on the ground' arrives only through atmAerial's in-scatter and will be subtle. At home distance the limb is a few px wide, so the visual payoff is modest until orbital-horizon-view exists. Impact is 2.

### `mobile-no-aa`: Bug: phones (medium tier) render with no anti-aliasing at all

*bug · impact 3→3 · effort S→S · verdict **keep***

**Pitch.** On phones, the Earth's limb, constellation lines and beam edges become smooth instead of stair-stepped.

**Current state.** context.js:78 enables canvas antialias only for 'low'. quality.js:111 sets msaa = 0 for medium on coarse pointers. postfx.js:175-184 then renders the scene target with 0 samples, and FinalPass (postfx.js:46-69) does no AA.

Repro: node scripts/smoke.mjs --mobile --gpu --url=/#intro=0. The tier is medium at DPR 1.5 of 3 with msaa 0. mobile.png shows a stair-stepped Earth limb against the Milky Way at the bottom of the globe.

**Proposal.** When composer && msaa === 0, add FXAA 3.11 (quality preset 12, about 9 taps) to FINAL_FRAG behind #define FXAA. Compute luma after tone mapping and dither after FXAA. Alternative: vendor three's examples/jsm/shaders/FXAAShader.js (MIT) through fetch-vendor and VENDOR.json. Cost: about 0.3-0.5 ms on mid-range phones. Size: about 3 KB.

**Risks.** FXAA slightly softens star points and beam dashes; skip it on very bright, isolated pixels. Keep the tonemapping and colorspace include order in the final pass.

**Files.** `js/render/postfx.js`, `js/render/context.js`, `js/core/quality.js`

**Verifier evidence.** context.js:78 sets antialias only for 'low'. quality.js:111 forces msaa = 0 for medium on coarse pointers, a deliberate SPEC §E.6 trade-off. postfx.js:172-183 makes the scene target with samples = msaa, and FINAL_FRAG (postfx.js:46-69) only does tone mapping, vignette and dither. grep for fxaa/smaa finds nothing. In mobile.png (390x844@3, medium, DPR 1.5) the bottom Earth limb against the Milky Way shows visible stair-steps. Constellation lines, beams and pin rings are screen-space quads with fwidth edges (beam.glsl.js:167-169, pin.js:80-88), so the aliasing is mainly mesh silhouettes: the Earth limb and the Moon disc.

**Verifier corrections.** Fold FXAA into FinalPass, the proposal's first option, with taps tone-mapped before computing luma. Do not vendor FXAAShader.js as a separate ShaderPass: a second pass needs EffectComposer's swap buffer, which postfx.js deliberately never allocates (all passes needsSwap=false, postfx.js:9-11). This is a gap in a deliberate trade-off rather than a bug.

### `ocean-glint-wind`: A sunglint with texture: wind-roughness field, calm lee wakes, Fresnel sky sheen

*visual · impact 3→3 · effort M→M · verdict **revise***

**Pitch.** The sunglint stops being a flashlight spot. It becomes a mottled, wind-textured mirror, with calm bright slicks in the lee of islands (the real wakes behind the Canaries seen in MODIS images) and a silvery ocean toward the limb.

**Current state.** Glint roughness is two global constants, A_CORE 0.045 and A_SHEEN 0.20 (earth.glsl.js:222-226). The glint is therefore a perfectly radial blob with a clipped core (globe-glint.png, globe-crop-glint.png). The day map's oceans are one flat colour, and there is no sky reflection.

**Proposal.** - Roughness field alpha(x) = mix(0.035, 0.28, w), where w = fBm(Earth-fixed position, simulated time), 3 octaves of value noise.
- Multiply w by a lee-shelter term from textureLod(ocean mask, uv, 5.5) (coast proximity: calm, bright water downwind of land) and by a gust term near clouds (cloudAt at lod 3).
- Use alpha in both GGX lobes.
- Fresnel sky reflection: col += F_Schlick(0.02, NoV) x Si x 0.6, reusing the in-scatter Si already computed at earth.glsl.js:236-243.
- Optional A/B: Khronos Neutral tone mapping gave a deeper Blue Marble navy: ocean sample (50,75,124) vs ACES (69,92,144) (globe-glint-neutral.png vs globe-glint.png).
Tiers: high full; medium uses 1 octave; low unchanged. Size: 0.

**Risks.** The noise must be Earth-fixed and lod-aware, or it shimmers. Spatially varying alpha changes the energy that reaches the bloom, so keep the min(.,6) cap. Switching tone mapper changes every module's look and is a separate decision.

**Files.** `js/render/shaders/earth.glsl.js`, `js/render/context.js`

**Verifier evidence.** earth.glsl.js:222-226: A_CORE = 0.045 and A_SHEEN = 0.20 are global constants. globe-glint.png shows a perfectly radial, smooth glint blob. The day map has a uniform ocean colour, confirmed by viewing earth_day_4096.jpg. Si is computed later in the shader (earth.glsl.js:236-243), after the glint is added (line 227).

**Verifier corrections.** (1) To reuse Si for the Fresnel sky sheen, move atmAerial above the glint, or add the sheen after line 241. (2) 'Calm lee wakes downwind of islands' needs a wind direction, and the app has none. Coast proximity from textureLod(mask, 5.5) alone only gives calm water around every coast. Either assume the trade-wind or zonal direction by latitude, or drop the lee term. (3) The mask source differs per tier: medium is specular .r (2k), high is brc4k.g (roughness) and low is derived. The coast-proximity term needs per-mode handling or should be high-only. (4) The ACES-to-Neutral tone-mapping A/B is a global look decision; do not bundle it here. The roughness-noise part on its own is a good, cheap upgrade.

### `tier-consistency`: Bug: different weather per tier, and a dirty low-tier ocean mask

*bug · impact 2→2 · effort S→S · verdict **keep***

**Pitch.** The planet looks the same on every tier. A governor downgrade or a Settings change no longer swaps the whole cloud field mid-session, and low-tier glints have no ghost holes.

**Current state.** Medium clouds come from earth_clouds_1024.png (textures.js:26) and high clouds from the blue channel of earth_bump_roughness_clouds_4096.jpg (textures.js:27): two different days of weather. At the same instant, globe-terminator-medium.png and globe-terminator.png show completely different systems over Morocco and the Atlantic, so the governor's high-to-medium step (quality.js:125-140) replaces the clouds live.

On low, the derived ocean mask (earth.glsl.js:146-151, earth.js:31) punches glint holes and grey ghost shapes around islands and seamounts (globe-crop-low-canaries.png vs globe-crop-high-canaries.png).

Repro: /#loc=48.85,2.35&t=2026-11-03T16:40:00Z&p=0&intro=0&ly=smka&cam=o:30,-5,1.9, once with q=high and once with q=medium.

**Proposal.** - Regenerate clouds1k from brc4k.b with a headless-Chrome build step: a 1024 PNG with alpha = smoothstep(0.2, 1, b), matching cloudAt mode 2 (earth.glsl.js:81). Make cloudAt modes 1 and 2 produce the same density curve.
- Low tier: ship a 1024x512 8-bit grayscale PNG water mask (about 20-30 KB, within low's 90 KB headroom) used with uMaskMode = 1 semantics. Alternatively, drop the glint on low.
- Add a smoke check that the cloud-coverage hash matches between medium and high.

**Risks.** The regenerated 1k clouds lose the hand-made alpha of the current PNG. Generating them needs Chrome in the data pipeline, which smoke.mjs already uses.

**Files.** `js/render/textures.js`, `js/render/earth.js`, `js/render/shaders/earth.glsl.js`, `assets/textures/earth_clouds_1024.png`, `scripts/check-size.mjs`

**Verifier evidence.** textures.js:26-27: medium clouds come from earth_clouds_1024.png and high clouds from the blue channel of brc4k. Comparing globe-terminator.png (high) with globe-terminator-medium.png at the same instant shows different weather: a large cloud band over Morocco on medium versus scattered Saharan cloud on high. A governor step or Settings change calls setQuality, then bindTier, then want('clouds','clouds1k') (earth.js:225-229, 346-366), so clouds swap live. globe-crop-low-canaries.png shows ghost glint holes and grey seamount shapes from the derived mask (earth.glsl.js:147-151) that the high crop does not have.

**Verifier corrections.** Instead of a 1024 PNG with alpha (the current one is 226 KB), ship a single-channel JPEG of brc4k.b, e.g. 2048x1024 at about 100-150 KB. It is sharper and smaller, and returns bytes to medium's 110 KB headroom. Make cloudAt mode 1 read .r with the same smoothstep(0.2,1) as mode 2 (earth.glsl.js:81). scripts/lib/chrome.mjs and scripts/lib/png.mjs already exist for the build step. Low gains are small at normal framing, so the low water mask is optional.

### `detail-tiles`: Close-zoom detail tiles (clipmap-lite) for the day and night maps

*performance · impact 3→2 · effort L→L · verdict **revise***

**Pitch.** Below about 1,500 km the surface sharpens to twice the linear resolution, so coastlines, river deltas and city grids hold up at the 510 km minimum altitude instead of dissolving into blur.

**Current state.** The best surface data is 4096x2048 (about 9.8 km/texel), but MIN_DIST is 1.08 ER (rig.js:49). At that distance the screen is about 0.7 km/px, a 14x magnification (globe-eclipse-close.png, globe-terminator-1p12.png). textures.js ASSETS (lines 21-32) has no regional assets.

**Proposal.** Data: an 8x4 grid of 45x45-degree tiles at 1024x1024 (8192x4096 equivalent, about 4.9 km/texel). Day tiles from BMNG 500 m and night tiles from NASA Black Marble 2016, both public domain. Leave out the about 10 ocean-only tiles. That is about 22 x 150 KB of day tiles plus 22 x 35 KB of night tiles, about 4.1 MB staged.

Runtime:
- On high, or on medium with maxTextureSize >= 4096, when camera distance is below 1.8, fetch the up to 4 tiles under the view.
- Composite them once into a 2048x2048 render-target atlas centred on the view. Recomposite only when the view centre crosses a tile boundary, so there is no per-frame allocation.
- earth.glsl.js gets one extra sampler plus uDetailRect, and crossfades from the base map by lod.

Budgets: add an ON_DEMAND category in scripts/check-size.mjs (lines 29-30), excluded from the tier budgets but counted in STAGING_BUDGET.
Build: scripts/build-tiles.mjs using the headless-Chrome helper, no npm deps.
Pairs well with the close-zoom-lights item.

**Risks.** It competes with seasonal-earth for the staging headroom (6.53/12 MB); doing both means raising the self-imposed 12 MB budget. Tile seams need a 1-texel gutter. Fetch latency means a pop-in that must crossfade. The gain is only 2x linear; 16k-equivalent tiles would exceed the staging budget.

**Files.** `js/render/textures.js`, `js/render/earth.js`, `js/render/shaders/earth.glsl.js`, `scripts/check-size.mjs`, `scripts/build-tiles.mjs`, `vendor/VENDOR.json`

**Verifier evidence.** MIN_DIST = 1.08 (rig.js:49). The best surface maps are 4096x2048 (textures.js:22-27). At 1.08 with FOV 45 on 900 px, the ground is about 0.47 km/px against 9.8 km texels, roughly a 20x magnification. grep for clipmap and detail tiles finds nothing. Staged size is 6.53/12 MB.

**Verifier corrections.** A 2x linear gain on the day map leaves surfaces about 10x magnified at minimum distance and is mostly masked by haze and clouds: poor return for an L effort that also competes with seasonal-earth for staging bytes. The visible close-zoom failure is the night lights (blocky squares in globe-terminator-close.png). Night tiles are mostly black and compress to almost nothing, so start with night-only tiles at 4x (16384-equivalent, ocean tiles skipped, likely 1-2 MB staged), composited into the proposed 2048 atlas. A full 8k single texture is not an alternative: about 180 MB of GPU memory with mips. The atlas render target must be rebuilt after context restore. Do close-zoom-lights first, since it costs 0 bytes.

## Lens: Sky view & ground experience

The sky view is robust (NaN guards, no allocations, render-on-demand). The night sky, the Milky Way and the copper lunar-eclipse Moon at 5° FOV are already good. Everything else rests on hand-tuning: three's Preetham dome with 8 text patches and a hand-built twilight chunk, a flat ground hemisphere, an eclipse 'corona' that is the Sun billboard's radial glow re-tinted, and star/Milky Way exposure that depends only on the Sun's altitude. That leaves the screenshot moments weak:
- a cream-white Sun at +1.4° altitude;
- totality as a 7 px dot, or a soft round halo when zoomed, with stars down to mag 5.7 (Praesepe) on a navy sky;
- a mag-6.5, Milky Way sky under a full Moon and over Ho Chi Minh City;
- a pure-black lower half of the screen from civil twilight on (about 45 % of a phone screen).
I also measured three inconsistent eclipse geometries in sky view. For Luxor on 2027-08-02, second and third contact come out at 10:02:25/10:08:47 for the drawn discs, 10:01:32/10:08:00 for the sky-darkening obscuration, and 10:01:50/10:08:14 in Astronomy Engine. The biggest opportunity is a real totality sequence (structured corona, Baily's beads, diamond ring, prominences, an asymmetric 360° sunset). It should sit on a single corrected eclipse geometry, and later on a physically based LUT atmosphere that carries the Moon's umbra in the air itself.

### `totality-sequence`: Totality from the ground: structured corona, Baily's beads, diamond ring, prominences, shadow bands ★

*feature · impact 5→5 · effort L→L · verdict **revise***

**Pitch.** Jump to the 2027 Luxor eclipse and the view zooms onto the Sun. The last crescent breaks into beads, flares into a diamond ring and opens onto a streamered pearly corona with pink prominences around a pitch-black Moon, while the horizon glows orange all around. This is the moment people would share.

**Current state.** Sky-view totality is the Sun billboard's symmetric glow re-tinted. bodies.js:36-40 sets SUN_ECL_CORONA, scale 0.2° and gain 0.9; it is faded in by coronaSky = smooth(0.985,1,obscuration) at bodies.js:403. DISC_FRAG (bodies.glsl.js:39-50) is a radial exp() glow with no angular structure. The Moon is drawn additively (bodies.glsl.js:168-175), so its disc shows the same navy as the sky. At FOV 8 (skyground-totality-zoom8.png) you get a navy disc in a soft round halo. 5 s before AE's second contact (skyground-c2-zoom8.png) there is a plain smooth crescent: no beads, no diamond ring, no chromosphere. The flare is simply occluded (flare.js:162-171). jumpToEvent keeps the 70° FOV (actions.js:575-581), so users land on a ~7 px dot (eclipse-sky.png). The 360° sunset is a 0.10-gain ring with a 4.6° e-folding (ground.glsl.js:67-68), barely visible in skyground-totality-horizon.png.

**Proposal.** (a) Pass the Moon's topocentric direction and angular radius (uMoonDir, uMoonR) to the Sun material. In DISC_VERT, project both into the billboard's screen-aligned tangent units and hand the offset to the fragment as a varying (a few flops per vertex, no allocation).
(b) Add a DISC_FRAG eclipse branch as a uniform branch, so the material never recompiles.
- Photosphere = limb-darkened disc AND |p-m| > R_m*(1+L(θ)).
- L(θ) is a procedural lunar limb profile: 6-8 hashed Gaussians plus fbm, amplitude ~1.5 arcsec (~0.16 % of R_m). Once the gap between the limbs is thinner than the valleys, the crescent breaks into Baily's beads by itself.
- Beads are HDR (x30-50), so bloom gives the diamond ring. A small in-shader 6-spike starburst covers low tier, which has no bloom or flare.
- flare.js can move its starburst element to the brightest bead's NDC.
(c) Corona: I(r,θ) = K*(r/R)^-6*(1+S(θ)) + F*(r/R)^-2.5.
- S(θ) holds helmet streamers about the solar equator and polar plumes, oriented by the true solar rotation axis. AE.RotationAxis('Sun', t) works: RA 19.08 h, Dec +63.87° for 2027-08-02.
- Give it a constant physical radiance (~1e-6 of the photosphere) masked by the Moon, so the existing adaptation (skyViewExposure plus ECL_ADAPT) reveals it rather than a smoothstep. The 6° quad (SUN_QUAD_RAD) holds 4 R☉ of corona.
(d) Chromosphere and prominences: a 1 % H-alpha-pink shell plus 3-5 hashed prominences. They show only where the Moon covers the photosphere, so they flash on the correct limb at second and third contact.
(e) Replace ground.glsl.js:67-68 with an azimuthal glow. A new pure helper umbraEdgeKm(posS, moonPosS, sunDirS, az) in shadow.js gives the distance to the umbra edge, which feeds a 16-float uniform (brighter where the edge is nearer, ~12° tall).
(f) Shadow bands: 2-4 % moving stripes on the ground while the crescent is under ~10 arcsec. They run in real time, so loop.js's continuous flag must cover them; off under reduced motion.
(g) jumpToEvent passes fovDeg 10 for local-solar-eclipse events; rig.startLook already accepts fovDeg (rig.js:592-603).
Cost: about 5 KB GLSL plus JS and no assets. Every tier works because the extra cost is per-pixel on one billboard. Text mode is unaffected; the Sky panel can add a countdown ('diamond ring in 12 s') from AE contact times.

**Risks.** Needs the eclipse-geometry fix first, or the beads and corona appear 17-35 s off the published contacts. The limb profile is procedural, not LOLA data, so label it illustrative. The HDR beads must go through pcFinite and a knee, so bloom does not smear NaNs or turn the corona into a slab. Shadow bands force continuous frames for about 2 minutes, which is acceptable. A new uniform branch adds ALU to the Sun quad only.

**Files.** `js/render/bodies.js`, `js/render/shaders/bodies.glsl.js`, `js/render/flare.js`, `js/render/shaders/ground.glsl.js`, `js/render/ground.js`, `js/astro/shadow.js`, `js/app/actions.js`, `js/app/loop.js`

**Verifier evidence.** Most of the current-state claims hold. bodies.js:36-40 sets SUN_ECL_CORONA, scale 0.2° and gain 0.9, and bodies.js:403 fades it in with coronaSky = smooth(0.985,1,obscuration). DISC_FRAG (bodies.glsl.js:39-50) is a purely radial exp() glow. flare.js:162-170 occludes the flare with the Moon. ground.glsl.js:67-68 gives a 0.10-gain ring with exp(-hp/0.08), a 4.6° e-folding. jumpToEvent (actions.js:575-578) calls setMode('sky',{look:{az,alt}}), and rig.setModeNow (rig.js:935-937) forwards only {animate} to startLook, so the FOV stays at 70. Screenshots agree: eclipse-sky.png shows a dot plus reticle, skyground-totality-zoom8.png a navy disc in a round halo, and skyground-c2-zoom8.png a smooth crescent with no beads. AE.RotationAxis('Sun', 2027-08-02T10:05Z) returns RA 19.0753 h, Dec 63.87°, so streamer orientation is feasible. Nothing like beads, prominences or a diamond ring exists (grep finds nothing).

**Verifier corrections.** (1) The per-fragment Baily's beads cannot work as specified. At FOV 8 on 900 px, 1″ is 0.031 px, so a 1.5″ limb profile is about 0.05 px. The Moon's depth-only pre-pass (bodies.js:252-266) also rejects every Sun fragment inside the mesh limb, so a DISC_FRAG mask can never reveal valleys. The crescent visible near C2 is only the 1-px uEdge anti-aliasing fringe. Better: compute beads in JS each frame. Sample the gap along ±60° of position angle around the contact point against a fixed 1-D limb-profile table, then draw 1-8 preallocated HDR point sprites at the open valleys. Their timing then stays physically correct, and the brightest one sets the flare's starburst position. (2) A 'constant physical corona radiance ~1e-6 revealed by the existing adaptation' is wrong. skyViewExposure only spans 0.35 to 1 (×2.9), not 1e6. Keep the corona display-referred, with a gain tied to the remaining photospheric flux the way ECL_ADAPT works, and add the angular S(θ) streamer term as a uniform branch in DISC_FRAG. (3) The Moon disc showing the local sky colour is physically right, because the airlight lies in front of the Moon. The real problem is the uniform, too-bright navy sky around the Sun. (4) Drop shadow bands: they are rarely seen, hard to verify, and force continuous frames. (5) Plumb fovDeg through rig.setModeNow/startToSky once, shared with eclipse-framing-moon-scale. (6) Hard dependency: land eclipse-geometry-mismatch first.

### `eclipse-geometry-mismatch`: Bug: sky view uses three inconsistent eclipse geometries (drawn totality ~35 s late, sky darkening ~17 s early)

*bug · impact 4→4 · effort S→S · verdict **keep***

**Pitch.** Make the drawn eclipse, the darkening sky and the published contact times agree to under a second. Without this, the diamond ring happens with the Sun still visibly uncovered, and the panel reads 'Partial solar eclipse, 100.0% of the Sun covered'.

**Current state.** The drawn Sun is bodies[0].dirS from AE.Equator(...,false,false) (snapshot.js:247): astrometric with no aberration. The drawn sky-view Moon comes from moonPosS - camera position on the unit sphere (bodies.js:453-461). obscurationAtObserver (snapshot.js:335-336), which drives sky darkening, the corona, the stars and the flare, mixes an aberrated geocentric Sun (sunDirS = GeoVector(Sun,t,true), snapshot.js:309-311) with spherical-Earth parallax from posS. The panel's solarDiscGeometry (sky-now.js:281-299) uses yet another combination. I measured with computeSnapshot every 250 ms, Luxor 2027-08-02:
- drawn discs: second contact 10:02:24.8, third contact 10:08:47.0;
- obscurationAtObserver: 10:01:32.0 to 10:08:00.3;
- AE.SearchLocalSolarEclipse: 10:01:49.6 to 10:08:14.3.
At AE's maximum, the astrometric Sun-Moon separation is 18.98 arcsec against 9.18 arcsec apparent; the Sun's annual aberration is 20.2 arcsec and the Moon's is 0. Repro: #loc=25.7,32.6&t=2027-08-02T10:01:45Z&view=sky&cam=s:195.3,81.8,8. The panel shows 'Partial solar eclipse, 100.0% of the Sun covered' (sky-now.js:264-271) over a visible crescent with a corona (skyground-c2-zoom8.png).

**Proposal.** Build one topocentric eclipse geometry in snapshot.js and use it everywhere in sky view.
- Compute the Sun's aberration displacement Δab = unit(Equator(Sun,t,obs,false,true)) - unit(Equator(Sun,t,obs,false,false)), one extra AE call per frame.
- Draw the Moon at unit(bodies[MOON].dirS - Δab). Stars and the Sun stay astrometric, the Sun-Moon geometry becomes apparent-correct, and star occultations by the Moon get fixed too.
- Use AE's WGS84 topocentric Moon direction instead of unit-sphere parallax.
- Compute obscurationAtObserver from those two directions and the AE angular radii (the inputs solarDiscGeometry already uses).
- In bodies.js, use that direction in sky view (skyBlend 1) and keep the camera-relative Moon only for orbit view.
I checked this in Node: the combined geometry gives second contact 10:01:49.75 and third contact 10:08:14.50, within 0.2 s of AE. The globe's shadow keeps its geocentric GeoVector geometry. Add a test asserting rendered contacts within 1 s of AE for 2026-08-12, 2027-08-02 and 2028-07-22.

**Risks.** One more AE.Equator call per 'frame' snapshot (~+0.02 ms). The orbit-to-sky transition must blend the two Moon directions, or the Moon jumps ~10-20 arcsec, which is invisible below FOV 20. docs/ASTRONOMY.md accuracy table needs updating. Keep the change pure: no three.js and no DOM in js/astro.

**Files.** `js/astro/snapshot.js`, `js/render/bodies.js`, `js/render/flare.js`, `js/ui/sky-now.js`, `test/astro.snapshot.test.mjs`

**Verifier evidence.** I reproduced this in Node with computeSnapshot every 250 ms at Luxor (scratchpad/verify/ecl.mjs). Drawn discs: C2 10:02:21.25 and C3 10:08:51.0, measured from the Sun's dirS against moonPosS minus posS; with the camera at EYE_R the reviewer got 10:02:24.8 and 10:08:47.0. obscurationAtObserver gives C2 10:01:31.5 and C3 10:08:00.75. AE gives C2 10:01:49.63 and C3 10:08:14.32. At AE's peak the astrometric separation is 18.98″ against 9.18″ apparent, with Sun aberration 20.20″ and Moon 0.00″. The panel (ecl2.mjs, solarEclipseState) reads 'Partial solar eclipse, 100.0% of the Sun covered' at 10:01:40, 10:01:45 and 10:02:10. At 10:08:10 it reads 'Total solar eclipse' while obscuration is 0.99943. skyground-c2-zoom8.png shows that crescent and the corona together. snapshot.js:247 uses Equator(...,false,false), snapshot.js:309-311 uses sunDirS from GeoVector(Sun,true), and solarObscurationAt uses posS on the unit sphere. docs/ASTRONOMY.md:293-294 lists the 20.8″ and 11″ terms but not their effect on eclipse contacts.

**Verifier corrections.** flare.js does not use obscurationAtObserver. It computes its own occlusion from moonPos minus camera against the Sun's dirS (flare.js:118-123, 162-170), so it follows the late drawn discs, not the early obscuration. It still has to move to the unified geometry. In sky view, implement the Moon fix by setting the Moon mesh translation (and moonDepth) to cam.position + dir·dist, where dir is the WGS84 topocentric AE direction minus Δab. Leave lighting uniforms alone: a 20″ shift at 60 ER is negligible. Write the 1 s contact test against computeSnapshot plus a pure helper, not bodies.js, which imports three.

### `real-sky-brightness`: 'Your real sky': moonlit sky plus light pollution estimated from the shipped night-lights map, with a Bortle slider ★

*feature · impact 5→4 · effort L→L · verdict **revise***

**Pitch.** Under a full Moon the sky turns a deep moonlit blue and the Milky Way fades. Over Ho Chi Minh City an orange light dome swallows all but ~50 stars. Drag the Bortle slider to 1 and the Milky Way blazes back, which is very educational and screenshot-worthy.

**Current state.** exposureFor() (photometry.js:195-206) depends only on the Sun's altitude, and it alone sets the star limit (sky.glsl.js:88-90) and the Milky Way gain (sky.js:519-521). Under a 100 % full Moon at 58° over Paris you still get mag-6.5 stars and a full Milky Way on a black sky (skyground-fullmoon.png). The Moon's aureole is a 0.012-gain halo (bodies.js:465-472). There is no light-pollution term: the Milky Way shows plainly over Ho Chi Minh City, a Bortle 8-9 city (skyground-hcmc-bortle.png). earth_night_4096.jpg (NASA Black Marble, public domain) loads on every tier as a critical texture (textures.js:25, keysForTier), but only the globe uses it.

**Proposal.** New pure module js/astro/skyglow.js:
(1) Krisciunas & Schaefer (1991) moonlit-sky brightness B_moon(ρ, Z, Z_moon, phase angle, k), plus the natural sky with van Rhijn airglow, in nanolamberts or mag/arcsec².
(2) A Schaefer-type limiting magnitude from background, e.g. m_lim ≈ 7.93 - 5·log10(10^(4.316 - b/5) + 1).
(3) lightPollution(lumWindow, latDeg) returns zenith artificial brightness plus a 16-bin azimuth glow, using Walker's law (I ∝ L·d^-2.5) and a Garstang-like altitude profile, mapped to SQM and Bortle 1-9.
Render side: on observer change only, drawImage a 96x96 source rect of the decoded night bitmap around the observer (~±400 km) into a small canvas and call getImageData once.
Shaders:
- STAR_VERT computes the background at each star's direction (analytic KS91 plus the light-pollution dome from a 16-float uniform), so stars near the Moon and in the city-glow sector vanish first.
- MW_FRAG multiplies by local contrast.
- The dome adds the moonlit sky and sodium/LED-tinted domes; the ground receives the matching illuminance.
UI: Settings gets 'Sky darkness: Auto (est. Bortle 8) / 1-9 / Pristine', plus a readout of roughly how many stars are visible (pure; works in text mode).
No new assets; about 6-8 KB of code; all tiers (uniform-driven).

**Risks.** The Black Marble JPEG is 8-bit, gamma-encoded and saturated in city cores, so the Bortle estimate is coarse. Calibrate on known sites (Atacama 1, Paris 8, HCMC 8-9) and let the slider override. Defaulting famous cities to a realistic washed-out sky is a product choice, so keep a 'Pristine' preset. Never getImageData the full 4k bitmap (64 MB readback). Credit NASA in About/THIRD_PARTY_NOTICES. The pure-module rule holds because sampling lives in js/render.

**Files.** `js/astro/skyglow.js`, `js/astro/photometry.js`, `js/render/sky.js`, `js/render/shaders/sky.glsl.js`, `js/render/ground.js`, `js/render/shaders/ground.glsl.js`, `js/render/bodies.js`, `js/render/textures.js`, `js/core/store.js`, `js/core/url-state.js`, `js/ui/settings.js`

**Verifier evidence.** exposureFor (photometry.js:195-206) depends only on sunAlt. skyground-fullmoon.png (Paris, full Moon at 58°) shows a black sky with a full Milky Way and constellations. skyground-hcmc-bortle.png shows a bright Milky Way over HCMC. The Moon aureole gain is 0.012 (bodies.js:465-472). textures.js:90 loads 'night' as critical on every tier. grep finds no bortle, skyglow or light-pollution code. Size: low tier is 3.71 of 3.80 MB (npm run size).

**Verifier corrections.** The night texture is not NASA Black Marble in the public domain. VENDOR.json lists it as 'CC-BY-4.0 (Solar System Scope, via three.js examples)', an artistically processed 267 KB JPEG that THIRD_PARTY_NOTICES already credits. A better source for the Auto estimate is data/cities.json, which has a pop field for 1621 cities. Sum Walker's law (I ≈ 0.01·P·d^-2.5, toward each city's azimuth) over cities within ~300 km in a pure js/astro module. That needs no GPU readback, works in text mode, is testable in Node, and gives the 16-bin azimuth dome directly. Optionally refine with the texture later. It underestimates small-town glow because only large cities are listed, which the slider covers. Map KS91 nanolamberts onto the app's display-referred night scale: the dome floor is about 1e-3 linear, so absolute units will not work. Put m_lim in photometry.js and expose it through exposureFor, so labels and the eclipse star limit share it.

### `physical-sky-lut`: Physically based atmosphere (Hillaire 2020 LUTs) with the Moon's umbra inside the air ★

*visual · impact 5→4 · effort XL→XL · verdict **keep***

**Pitch.** One model gives a deep blue day sky, a flattened orange Sun under a golden aureole, the Earth's shadow and Belt of Venus, the purple light and the blue hour. During totality the umbra becomes a dark volume of air, so the asymmetric 360° sunset and the shadow sweeping in from the west fall out of the physics.

**Current state.** ground.js:41-75 wraps three's Preetham Sky in 8 string patches (ground.glsl.js:93-116), plus a hand-tuned TWILIGHT_CHUNK (ground.glsl.js:20-70: k = exp(-s/4.2), a fixed belt colour, airglow), goldenHour (73-79) and skyKnee (82-85). Symptoms:
- the sunward horizon at -2.8° is pink rather than gold (sky-sunset-paris.png);
- the south is already black at -11.8° nautical twilight (sky-dusk.png);
- the anti-solar sky at -7.6° is black (skyground-lunar-eclipse-paris.png);
- totality is a uniform navy dome (skyground-totality-wide.png);
- the Sun is a cream disc at +1.4° (skyground-lowsun-zoom.png).
The globe uses a separate, inflated-scale-height model (atmosphere.glsl.js ATM_HR 5x real).

**Proposal.** Port Hillaire's 'Scalable and Production Ready Sky and Atmosphere' (EGSR 2020; reference code MIT) to GLSL ES 3.0 as js/render/skyatmo.js plus shaders/skyatmo.glsl.js.
- Transmittance LUT 256x64 and multi-scattering LUT 32x32, rendered once at init into HalfFloat render targets.
- Sky-view LUT 192x108 with non-linear altitude mapping, re-rendered only when the Sun moves more than 0.02°, the observer changes, or an eclipse is in progress (~20k px x 30 steps, about 0.2 ms).
- Real-scale Rayleigh, Mie and an ozone layer. The ozone Chappuis band keeps the twilight zenith blue and produces the purple light.
- The dome samples the LUT. The Sun billboard takes its tint from the transmittance LUT, replacing extinctionRGB, so disc and aureole agree.
- Eclipse: multiply the direct-sun term at each raymarch sample P by discVisible(rS, asin(Rm/|M-P|), sep). This function already exists in JS (shadow.js:133) and GLSL (bodies.glsl.js:189).
- Moonlight: an optional second view-LUT pass with the Moon as the light, scaled by 10^(-0.4(m_moon - m_sun)), gives the moonlit sky and shares the real-sky-brightness idea.
- Keep the display-referred skyViewExposure and the pre-bloom knee.
- Fallback: without EXT_color_buffer_half_float, keep the current Preetham path. Low tier uses a 96x54 view LUT with 16 steps, paid only when the Sun moves. Text mode is unaffected.
Size: about 15-20 KB of code.

**Risks.** The largest rework in this lens: matching the hand-tuned look across day, golden hour, civil, nautical, totality and night under ACES needs a review pass. Budget: low tier has only ~90 KB headroom (3.71 of 3.80 MB), so 20 KB fits, but combined with the other ideas it needs a re-baseline. Half-float precision at deep twilight needs log or pre-scaled storage. The SKY_PATCHES tests that pin vendored Sky.js must change. Render targets are allocated once, which satisfies the no-per-frame-allocation rule.

**Files.** `js/render/ground.js`, `js/render/shaders/ground.glsl.js`, `js/render/skyatmo.js`, `js/render/shaders/skyatmo.glsl.js`, `js/render/bodies.js`, `js/render/context.js`, `js/main.js`, `test/render.ground.test.mjs`

**Verifier evidence.** ground.js:41-75 wraps Preetham Sky with SKY_PATCHES (ground.glsl.js:93-116) plus a hand-tuned TWILIGHT_CHUNK. The symptoms check out. sky-sunset-paris.png at -2.8° has a pink sunward band. In sky-dusk.png (HCMC, -11.8°) the sky samples (1,3,10)-(4,7,18), essentially black. skyground-totality-wide.png is a uniform navy dome. In skyground-lowsun-zoom.png the disc samples (255,251,240) on a (247,214,180) sky. postfx.js:94 already checks EXT_color_buffer_float/half_float and uses HalfFloatType. discVisible exists in JS (shadow.js:133) and GLSL. Low tier has about 90 KB of headroom.

**Verifier corrections.** (1) Hillaire's multi-scattering LUT assumes the whole atmosphere is lit. Inside the umbra the MS term must also be masked, or the umbra air glows. A separate low ambient from the sunlit air outside the umbra is then needed, or the totality zenith goes black instead of deep blue. (2) In fast time the Sun moves every frame, so the view LUT re-renders every frame. Budget that on low-tier mobile, not just the 0.2 ms desktop figure. (3) The SKY_PATCHES test is test/render.shaders.test.mjs:82, and render tests read source text because these modules import three (render.transition.test.mjs:7). There is no render.ground.test.mjs. (4) Keep the existing night, airglow and totality-floor terms below about -12°, where the LUT model fades out. This supersedes low-sun-white-disc and part of twilight-lit-ground.

### `procedural-landscape`: Ground 2.0: a per-place horizon silhouette, sea horizons with a moon-glitter path, and sky-lit land ★

*visual · impact 4→4 · effort L→L · verdict **revise***

**Pitch.** The empty black lower half becomes a horizon: a hazy far ridge and a black tree line silhouetted against the sunset. Coastal cities get a sea horizon with the Moon's glitter path running toward you. That silhouette-against-twilight frame is what people photograph.

**Current state.** GROUND_FRAG (ground.glsl.js:142-184) is a flat hemisphere with its edge at the mathematical horizon (alpha = smoothFall(0.0025,-0.0025,h), line 178). Ground colour is 0.0022 at night and a flat (0.36,0.35,0.29)·light by day. Its skylight term 0.30·sky² with sky = smoothstep(-7,3,sunAlt) (lines 158-161) is about 0.003 at Sun -5°, so the land is pure black through civil twilight. That black covers about 45 % of a phone screen (skyground-mobile-dusk.png) and about 40 % on desktop (sky-night.png, skyground-atacama-mw.png). Default look altitude is 15° at 70° FOV (rig.js:214, rig.js:41).

**Proposal.** (1) Silhouette in GROUND_FRAG from the azimuth φ:
- a far ridge h_far(φ) between 0.2° and 1.5° (periodic 1-D fbm, seed = hash of lat/lon rounded to 0.1°, so each place keeps its own horizon), blended into the horizon haze by aerial perspective;
- a near band h_near(φ) of trees or roofline, higher-frequency, near-black when backlit;
- edges anti-aliased with fwidth.
(2) Terrain character is chosen once per observer from data already loaded (the same window read as the light-pollution idea): mean day-map colour (forest, desert, snow), ocean mask (specular or derived) and city-light density per azimuth sector.
(3) Sea sectors: a flat horizon, Fresnel reflection of the sky function evaluated at the mirrored direction, and an analytic glitter path under the Sun and Moon (a vertically elongated Gaussian lobe in Δaz whose width grows toward the viewer).
(4) Ground irradiance = sun·sinAlt + skylight (reuse the twilight k from TWILIGHT_CHUNK) + moonlight (phase and altitude) + the light-pollution term, so civil twilight shows dim blue-grey land and a full Moon silvers it.
(5) Mirror the silhouette as a pure JS function so flare.js:173-178, picking and labels hide bodies behind the hills consistently.
(6) Add a Layers toggle 'Landscape'; off gives today's flat mathematical horizon, matching the almanac.
Low tier: one layer and no sea reflection. Cost: noise only for h < 3°, about 3-4 KB GLSL, no assets.

**Risks.** A silhouette makes things rise and set a few minutes off the almanac's mathematical horizon. Keep the far ridge low, make the layer toggleable and say so in the Sky panel. Procedural hills are fiction, so label them 'illustrative landscape'. The sea-sector detection from an 8-bit ocean mask is approximate near harbours. The silhouette must also hide the Sun and Moon below it, which means extending the existing horizon test in flare and pick code.

**Files.** `js/render/shaders/ground.glsl.js`, `js/render/ground.js`, `js/render/flare.js`, `js/camera/picking.js`, `js/render/labels.js`, `js/geo/horizon.js`, `js/core/url-state.js`

**Verifier evidence.** GROUND_FRAG (ground.glsl.js:142-184) is a flat hemisphere with alpha = smoothFall(0.0025,-0.0025,h) at line 178. Its skylight is 0.30·sky² with sky = smoothstep(-7,3,sunAlt), which I computed as 0.0032 at -5°. The night colour is 0.0022. Pixel samples: at Sun -5° the ground is (1,2,3) and (1,1,2) (skyground-antisolar-dusk.png); at -11.8° it is (1,1,2) (sky-dusk.png). skyground-mobile-dusk.png shows black ground over about half the phone screen. Default look alt is 15° (rig.js:214). grep finds no landscape or silhouette code.

**Verifier corrections.** Do not implement the silhouette as hash/fbm noise in GLSL mirrored by JS. fract(sin(x)*43758.5) differs across GPU precisions and vendors, so flare, labels and picking would disagree with the drawn hills. Instead, generate the horizon profile once per observer in a pure module (js/geo/horizon.js, about 256 samples as a Float32Array). Upload it as a uniform array or a 256×1 DataTexture, and have the JS horizon tests (flare.js:173-178, bodies.pickCandidates, labels) read the same array. Keep the default far ridge at 0.5° or less: a 1.5° ridge delays sunset by several minutes against the panel's 'Sets 17:27'. The specular ocean map loads only on medium, so the sea detection needs the derived-mask path (a one-off canvas drawImage of the decoded bitmap per observer change). Ground lighting must be calibrated against the ACES toe (see twilight-lit-ground).

### `low-sun-white-disc`: Fix the cream-white sunset Sun: redden Preetham's forward lobe and keep the disc above its sky

*bug · impact 4→3 · effort S→S · verdict **revise***

**Pitch.** At sunset the Sun becomes the deep orange disc everyone expects, instead of a white smudge on a beige sky. It is a one-line patch with an outsized payoff.

**Current state.** Paris, 2026-11-03 16:12Z, Sun +1.45°, cam s:245.3,1.4,5 (skyground-lowsun-zoom.png): the Sun draws as a cream/white disc. bodies.js:405-408 already reddens the core with extinctionRGB, to roughly (2.6, 0.56, 0.03)×display. It is added onto Preetham's Mie forward lobe (vendor Sky.js:191 'vec3 betaMTheta = vBetaM * mPhase;', mieDirectionalG 0.8 at ground.js:67). skyKnee (ground.glsl.js:82-85) clamps that lobe toward white, and goldenHour (ground.glsl.js:73-79) only warms it by at most (1.30,0.80,0.48). Sky plus disc saturates to cream under ACES. The wide view at +1.4° (skyground-sunset-wide.png) shows the same pale halo.

**Proposal.** Add one SKY_PATCHES entry: 'vec3 betaMTheta = vBetaM * mPhase;' → 'vec3 betaMTheta = vBetaM * mPhase * uSunTint;'. uSunTint is the Sun's extinctionRGB(sinAlt) normalised to its max channel and set in ground.js apply(); the transmittance is already computed in JS (bodies.js:57-64). The aureole then reddens with the disc. Lower the knee asymptote near the Sun while sunAlt < 5°. In bodies.js, give the extincted core an adaptation gain g = T.g^-0.5, clamped 1-4, so the disc stays at least 2x its local sky in luminance. Extend the unit test that checks patches against vendored Sky.js. Applies to all tiers; about 1 KB.

**Risks.** Another string patch against vendored Sky.js, already guarded by the patch-miss warning and test. Superseded if the physical-sky-lut idea lands, but cheap enough to do now. Needs bloom-threshold checks so the boosted core does not bloom into a slab at -0.5° to +3°.

**Files.** `js/render/shaders/ground.glsl.js`, `js/render/ground.js`, `js/render/bodies.js`, `test/render.ground.test.mjs`

**Verifier evidence.** Reproduced from skyground-lowsun-zoom.png (Paris, +1.4°, FOV 5). The disc centre samples (255,251,240). The sky 60 px away is (253,231,202), and the sky elsewhere is (247,214,180) to (245,215,177): the sky itself is near-clipping beige. Vendored Sky.js:191 is 'vec3 betaMTheta = vBetaM * mPhase;'. I computed the core at about (2.54,0.545,0.031) (KY airmass 23.1, display 0.71), matching the claim. goldenHour caps at (1.30,0.80,0.48), and skyKnee is at ground.glsl.js:82-85. Tone mapping is ACESFilmic (context.js:86).

**Verifier corrections.** Drop the core adaptation gain (g = T.g^-0.5, up to 4×). It would push G from 0.55 toward 2.2 and whiten the disc further under ACES. The whiteness comes from the bright sky under the disc, not from a dim core. Keep the Mie-lobe tint patch, but blend uSunTint toward 1 for a high Sun (e.g. mix by smooth(12,0,sunAlt)); otherwise the whole daytime haze yellows. Then lower the sky's luminance near a low Sun (knee asymptote or local exposure), so the core's hue survives ACES. Superseded by physical-sky-lut if that lands.

### `eclipse-framing-moon-scale`: Frame eclipses on arrival and add a 'magnify Sun and Moon' option for wide fields

*ux-polish · impact 4→3 · effort S→S · verdict **keep** · tracked under `eclipse-local-circumstances-and-framing`*

**Pitch.** Clicking 'Total solar eclipse visible here' or 'Total lunar eclipse' lands you looking at a big corona or a blood-red Moon, not a 7 px dot. A full Moon rising at dusk reads as the Moon again.

**Current state.** jumpToEvent (actions.js:575-581) turns to the body but keeps the current FOV, default SKY_FOV 70 (rig.js:41). The 0.53° disc is about 7 px tall on a 900 px canvas (eclipse-sky.png). The lunar-eclipse Moon at 70° FOV is a few dark-red pixels under its label (skyground-lunar-eclipse-paris.png), though at 5° FOV it is lovely (skyground-lunar-zoom.png). A full Moon rising at -1.4° Sun is a dot (skyground-moonrise.png). At narrow FOV the label dot sits on the disc ('Moon' in skyground-crescent-zoom.png, 'Sun' in skyground-totality-zoom8.png) because labels use a fixed GLYPH_OFFSET.

**Proposal.** (1) In jumpToEvent, pass look.fovDeg for eclipse events: 10° for local-solar-eclipse, 8° for a lunar eclipse whose Moon is up. rig.startLook already accepts fovDeg (rig.js:592-603) and URL cam state carries it.
(2) Add a sky-view option 'Sun and Moon size: true / magnified', like Stellarium's Moon scale. When magnified and FOV > 25°:
- scale uCoreR and the Moon mesh by k = clamp(fov/20, 1, 3.5), via moon.matrix scale in bodies.js:336-341 and SUN core radius at bodies.js:358-360;
- force k = 1 whenever Sun-Moon separation is under 3°, so eclipse geometry stays true;
- show a small 'x3' note in the Sky panel.
(3) labels.js: offset body labels by the apparent disc radius (moonAngR·pxPerRad, already computed in bodies.js:460) so names never sit on the disc.
All tiers; under 1 KB.

**Risks.** A magnified Moon is not to scale, so it must be opt-in or clearly labelled, and off whenever true geometry matters (eclipses, occultations, conjunction screenshots). Picking radii must follow the scale.

**Files.** `js/app/actions.js`, `js/camera/rig.js`, `js/render/bodies.js`, `js/render/labels.js`, `js/app/labels-feed.js`, `js/core/store.js`

**Verifier evidence.** actions.js:575-578 turns to the body but passes no FOV, and rig.setModeNow (rig.js:935-937) forwards only {animate} to startLook (rig.js:592-603 accepts fovDeg). The local-solar-eclipse event sets view:'sky' and select:'sun' (events.js:270-272). eclipse-sky.png shows totality as a few pixels under a reticle at FOV 70. Labels use a fixed GLYPH_OFFSET [7,-7] (labels-feed.js:54, 90-93), and the 'Sun' dot sits inside the Moon disc in skyground-totality-zoom8.png. moonAngR·pxPerRad is already computed (bodies.js:453-460, 479).

**Verifier corrections.** The fovDeg has to be plumbed through rig.setMode's look and setModeNow/startToSky, not only through jumpToEvent. Force the magnifier k = 1 during lunar eclipses too, not only when the Sun-Moon separation is under 3°. MOON_FRAG computes the umbra per fragment from vPw (bodies.glsl.js:209-226), so a 3.5× Moon would straddle the umbra and show false partial shading. Picking and reticle radii must follow k. The FOV-on-jump part overlaps totality-sequence (g); implement it once.

### `totality-star-budget`: Bug: totality shows stars to mag 5.7 (the Praesepe cluster) instead of planets and first-magnitude stars

*bug · impact 3→3 · effort S→S · verdict **keep***

**Pitch.** Totality's dark sky shows only Venus, Jupiter, Mercury and a handful of bright stars, which is what makes it eerie. Today it looks like a dark-site night.

**Current state.** sky.js:509: eclipseStars = 0.8 * smooth(0.97,1.0,obscuration) * skyBlend, then starExp = max(stars, eclipseStars). STAR_VERT (sky.glsl.js:89) sets lim = mix(-1, uMagLimit, sqrt(e)), giving -1 + 7.5·0.894 = 5.7 on high (5.3 medium, 4.4 low). Repro: #loc=25.7,32.6&t=2027-08-02T10:05:00Z&view=sky&cam=s:195,40,100. The result is hundreds of stars and the Beehive cluster on a navy sky (skyground-totality-wide.png); looking north shows the whole Big Dipper and Draco (skyground-totality-horizon.png). The ramp also starts at obscuration 0.97, about 1-2 min before second contact, while 3 % of the photosphere is still ~10^4x brighter than the corona.

**Proposal.** Set the eclipse exposure to about 0.17, giving lim ≈ -1 + 7.5·0.41 ≈ 2.1, so roughly 40 stars plus the planets. Ramp it on the remaining photospheric flux (1 - obscuration)^1.4, the same quantity ground.js ECL_ADAPT uses, between 1e-3 and 1e-5 instead of obscuration 0.97 to 1. Clamp the Milky Way to 0 during totality. Add a test: snapshot at 2027-08-02T10:05Z gives a star limit of at most 2.5. All tiers; a two-line change.

**Risks.** Totality sky brightness varies with umbra size and haze (limits of about 1.5-3), so pick a mid value and document it in docs/ASTRONOMY.md.

**Files.** `js/render/sky.js`, `js/render/shaders/sky.glsl.js`, `test/render.sky.test.mjs`

**Verifier evidence.** sky.js:509-510 sets eclipseStars = 0.8·smooth(0.97,1,obscuration)·skyBlend and starExp = max(...). In STAR_VERT, lim = mix(-1, uMagLimit, sqrt(e)), and quality.js gives starMagLimit 5.0/6.0/6.5. That puts the limit at 4.37/5.26/5.71 for low/medium/high, as claimed. skyground-totality-wide.png and eclipse-sky.png show hundreds of stars and a cluster on a navy sky at totality. Node (ecl3.mjs): obscuration reaches 0.97 at 09:58:44.5, 0.985 at 09:59:53.5 and totality at 10:01:31.5.

**Verifier corrections.** The ramp starts about 2.8 minutes before C2, not 1-2. The Milky Way is already 0 in daytime, because exposureFor.milkyWay depends only on sunAlt, so no clamp is needed. Specify the totality limit in magnitudes rather than exposure (e = ((m+1)/(tierLimit+1))²); otherwise e = 0.17 gives about 1.5 on low and 2.1 on high. Move the eclipse term into the pure exposureFor (photometry.js) so the proposed test can run in Node. sky.js imports three, and there is no render.sky.test.mjs.

### `sky-view-refraction`: Draw refraction in sky view: the Sun is hidden at the official sunset, and low discs never flatten

*accuracy · impact 4→3 · effort M→M · verdict **keep***

**Pitch.** At the moment the panel says 'Sun UP 0°, sets 17:27', the Sun sits on the horizon as a flattened orange ellipse instead of being already gone. Rising and setting things then match the almanac, and the green rim becomes possible.

**Current state.** Rendered directions are geometric. snapshot.js:300 adds refraction only to the numbers (altDeg), and INFINITY_VERT_CHUNK (sky.glsl.js:16-21) projects the raw direction. Repro: Paris at AE sunset 2026-11-03T16:27:09Z, cam s:247.5,1,6 (skyground-sunset-instant.png). The panel lists the Sun as 'UP 0° WSW', but it is drawn about 0.84° low, fully under the ground with an italic is-below label. AE puts the geometric centre at -0.836° and the refracted centre at -0.217°. Low discs are perfect circles, though the vertical diameter should shrink about 10 % at 1.5° (skyground-lowsun-zoom.png). flare.js:174-175 and bodies.js:314 use geometric sinAlt for the horizon cut.

**Proposal.** Add refractLift(dir, up, k) to INFINITY_VERT_CHUNK. It computes alt, adds Saemundsson R(alt) (mirror of photometry.js:135-141, clamped at -1°) times k = skyBlend, and rotates toward up.
- Use it per vertex in STAR_VERT, GLYPH_VERT and LINE_VERT (endpoints), and per direction in MOON_VERT about the camera.
- In DISC_FRAG, map each fragment's apparent altitude back to true altitude with Bennett's apparent-to-true formula before the disc test, so the Sun flattens and its lower limb compresses correctly.
- MW_FRAG does the same inverse per fragment.
- Apply the same lift in JS where directions turn into screen positions or horizon tests: labels-feed and labels, picking.js, flare.js, pickCandidates.
- Optional by-product: per-channel dispersion (n-1 ratio ≈ 1 : 1.009 : 1.022 for R:G:B) gives a green upper rim at minimum FOV.
Tests: the sunset instant draws the upper limb within 1 px of the horizon at FOV 5. All tiers; about 2 KB.

**Risks.** Touches every at-infinity shader, so labels and picking must use the same mapping or they drift by up to 0.5° at the horizon. The alt-az grid must stay unrefracted, since it is apparent coordinates. Orbit view is untouched because k = skyBlend. The green flash is sub-pixel except near FOV 5; do not exaggerate it.

**Files.** `js/render/shaders/sky.glsl.js`, `js/render/shaders/bodies.glsl.js`, `js/render/bodies.js`, `js/render/sky.js`, `js/render/flare.js`, `js/render/labels.js`, `js/camera/picking.js`, `docs/ASTRONOMY.md`

**Verifier evidence.** INFINITY_VERT_CHUNK (sky.glsl.js:16-21) projects raw directions. snapshot.js:300 adds refractionDeg only to the numeric altDeg. skyground-sunset-instant.png at the AE sunset instant (16:27:09Z) shows the panel listing 'Sun UP 0° WSW' while the drawn Sun and its label sit about 0.8° below the ground line, with the italic is-below style. flare.js:174-175 and bodies.js:314/530 use geometric sinAlt. photometry.js:135-141 is the Saemundsson mirror. No refraction-lift code exists.

**Verifier corrections.** Simpler: put the lift inside infinityClip once, behind a uniform strength (skyBlend), and have the ground hemisphere and alt-az grid pass 0, instead of editing each vertex shader. Shared chunk uniforms need care, because STAR_VERT already declares uUp. The Moon is a 3D mesh, not drawn through infinityClip, so its sky-view translation must be lifted in bodies.js. The per-fragment inverse is needed only in DISC_FRAG for the flattening. Skip the green rim.

### `daylight-label-policy`: Daylight label policy: no names for stars you cannot see, and no dark embossed halos on a bright sky

*ux-polish · impact 3→3 · effort S→S · verdict **keep***

**Pitch.** The daytime and sunset sky looks clean and photographic. Star and constellation names fade out with the stars and return at dusk exactly as each star appears, which also teaches when stars come out.

**Current state.** starAnchors (labels-feed.js:134-149) checks only mag ≤ STAR_NAME_MAG_SKY 2.5 (labels-feed.js:32), and constellationAnchors (152-166) has no gate. Both are added whenever the layers are on (209-210), regardless of daylight. .lbl__text has a dark triple text-shadow (css/app.css:188). As a result, Sabik, Antares, Dschubba, Larawag, Menkent and 'SERPENS CAPUT' print with dirty dark halos on a blue noon sky (sky-day-paris.png, skyground-sunset-wide.png), while the stars themselves are culled by STAR_VERT's limit (sky.glsl.js:88-90). Constellation lines keep a 0.15 alpha floor in daylight (sky.js:527).

**Proposal.** loop.js:228 already computes exposureFor per frame; pass exposure.stars, plus the eclipse star exposure, to buildAnchors via opts.
- Mirror the shader limit: lim = -1 + (tierMagLimit + 1)·sqrt(e). Drop star names with mag > lim + 0.3 and fade the rest via an is-faint class.
- Hide constellation names and drop the line floor (sky.js:527 Math.max(e,0.15) → e) when e < 0.1.
- Add a root class is-daysky when sky view has e < 0.1 and switch .lbl__text to a soft light halo with dark-tinted body labels.
Pure and testable in js/app; all tiers; under 1 KB.

**Risks.** Some users like names for orientation by day. Keep body labels (Sun, Moon, Venus) and the cardinals always, and consider a 'show names in daylight' preference. Label churn at the threshold needs hysteresis (±0.2 mag).

**Files.** `js/app/labels-feed.js`, `js/app/loop.js`, `js/render/sky.js`, `css/app.css`, `test/app.labels-feed.test.mjs`

**Verifier evidence.** starAnchors (labels-feed.js:134-149) gates only on mag ≤ 2.5, and constellationAnchors (152-166) has no gate at all. .lbl__text has a dark triple text-shadow (css/app.css:188). sky.js:527 sets cons alpha = 0.28·max(e,0.15). sky-day-paris.png (Sun 25.7°) shows Sabik, Antares, Dschubba, Larawag, Menkent, SERPENS CAPUT, LIBRA and others with dark halos on a blue sky. skyground-sunset-wide.png (+1.4°) shows the same. loop.js:228 computes exposureFor each frame.

**Verifier corrections.** buildAnchors runs only when the feed is dirty: the store subscriptions on selection, layers and observer.name (labels-feed.js:308-312) or a mode change. Passing exposure through opts would therefore freeze the gating as time advances. Instead, set a per-anchor faint/hidden flag in sync(), as is already done for `below` (labels-feed.js:351-354), or mark the feed dirty when the quantized limit (0.2 mag steps) changes. Share the limit function with totality-star-budget.

### `twilight-lit-ground`: Quick win: the ground stays visible through civil twilight and moonlight, and portrait framing shows less of it

*visual · impact 3→3 · effort S→S · verdict **revise***

**Pitch.** At dusk the land is dim blue-grey rather than a black void, and a full Moon silvers it. On phones the sky gets the screen space.

**Current state.** GROUND_FRAG skylight is 0.30·sky² with sky = smoothstep(-7,3,sunAlt) (ground.glsl.js:158-161), about 0.003 at Sun -5°. There is no Moon term, and the night floor is 0.0022. So civil twilight (by definition you can still read outdoors) shows a pure-black ground (skyground-antisolar-dusk.png), filling about 45 % of a portrait phone (skyground-mobile-dusk.png). The default look altitude is 15° (rig.js:214) whatever the aspect ratio.

**Proposal.** Tie the ground's skylight to the dome's own twilight intensity: reuse k = smoothFall(4,-1,sunAlt)·exp(-s/4.2) from TWILIGHT_CHUNK as a shared chunk, with ground radiance ≈ 0.25·albedo·(horizon sky luminance). Add moonlight E ∝ 10^(-0.4·m_moon)·sin(alt_moon) with a blue-grey scotopic tint. In rig.js, use a default look altitude of 25° when aspect < 1. S effort; all tiers. A stepping stone toward the procedural-landscape idea.

**Risks.** The night ground must stay darker than the sky's horizon band so the horizon still reads; check the ACES toe. Changing the default look altitude alters shared links without cam=, so apply it only when there is no cam in the hash.

**Files.** `js/render/shaders/ground.glsl.js`, `js/render/ground.js`, `js/camera/rig.js`

**Verifier evidence.** ground.glsl.js:158-161 has skylight 0.30·sky², which I computed as 0.0032 at -5°. There is no Moon term. Measured ground pixels: (1,2,3) at Sun -5° (skyground-antisolar-dusk.png); (18,17,15) to (55,41,31) at -2.8° (sky-sunset-paris.png); black over about half the phone screen in skyground-mobile-dusk.png. rig.js:214 uses a default alt of 15 at any aspect ratio.

**Verifier corrections.** The proposed level does not visibly change anything. 0.25·albedo·L_horizon is about 0.25·0.3·0.06 = 0.0045 linear, close to today's 0.0033. Through three's ACES fit both come out around 1/255 (I computed 0.0045 → about 2/255 and 0.03 → about 31/255). To read as dim blue-grey at -3° to -6°, the ground needs roughly 0.02-0.03 linear, i.e. about 0.3-0.5× the horizon band's display level, while staying below it so the horizon still reads. Moonlight must be scaled to the same display-referred level, not the physical 10^-0.4m. Apply the portrait 25° default only when the hash has no cam.

### `zodiacal-light-airglow`: Zodiacal light, gegenschein and true-colour airglow for dark skies

*feature · impact 3→2 · effort M→M · verdict **keep***

**Pitch.** On a spring evening or autumn morning at a dark site, a faint cone of light leans along the ecliptic out of the twilight, with the gegenschein opposite the Sun and green airglow bands on the horizon. Few sky apps get these right, and they appear automatically in the right place.

**Current state.** There is no zodiacal light or gegenschein anywhere (grep finds none). Airglow is a bluish horizon band vec3(0.0105,0.014,0.018)·exp(-hp/0.11) (ground.glsl.js:58-62). Real airglow is dominated by the green 557.7 nm O I line, with red 630 nm higher up. The Atacama night horizon shows only a faint blue line (skyground-atacama-mw.png).

**Proposal.** Zodiacal light: embed the Leinert et al. (1998, A&AS 127, 1) brightness table of helioecliptic elongation by ecliptic latitude (about 19x10 values in S10 units, ~400 B as a JS array, a published scientific table, cited) and upload it as a tiny DataTexture or uniform array. Evaluate it in the Milky Way pass (MW_FRAG already works per direction and has a world-to-galactic matrix; add ecliptic coordinates through a uniform matrix and the Sun's ecliptic longitude). Apply extinction toward the horizon and fade with the sky background (best with real-sky-brightness), so it shows only at Bortle 1-3, with no Moon, after astronomical twilight. Airglow: retint to green with a faint red layer using a van Rhijn profile peaking ~10° up. Optional slow gravity-wave banding on the high tier (static unless twinkle is already animating). About 2 KB; medium and high tiers only.

**Risks.** Visible only under very dark skies, so its value multiplies with the real-sky-brightness idea and is near zero alone. Keep it faint enough not to raise the black level of every night shot. Credit the table in docs/ASTRONOMY.md.

**Files.** `js/render/shaders/sky.glsl.js`, `js/render/sky.js`, `js/render/shaders/ground.glsl.js`, `js/astro/skyglow.js`

**Verifier evidence.** grep finds no zodiacal light or gegenschein. The airglow is the bluish band vec3(0.0105,0.014,0.018)·exp(-hp/0.11) (ground.glsl.js:58-62). MW_FRAG already has a per-fragment direction and uToGal (sky.glsl.js:169, 266), so adding an ecliptic matrix is easy. The Atacama shot shows only a faint blue horizon line.

**Verifier corrections.** This must follow real-sky-brightness. With today's model every site is pristine; the Milky Way already shows over HCMC, so zodiacal light would show over every city and make realism worse. Gate it on the sky-background or Bortle term. Keep the airglow colour change subtle, since scotopic vision is nearly colourless, and leave out the animated banding.

### `chromatic-scintillation`: Chromatic scintillation for bright low stars (Sirius flashing colours on the horizon)

*visual · impact 2→2 · effort S→S · verdict **keep***

**Pitch.** A low Sirius or Capella flickers red, green and blue the way it does on a cold night. It is a tiny touch that makes the high-tier sky feel alive.

**Current state.** STAR_VERT twinkles brightness only, with two tones per star scaled by (1-sinAlt) (sky.glsl.js:104-111). Colour stays fixed, and stars are already reddened by extinction (sky.glsl.js:100-103). Twinkle exists on the high tier only (quality.js high twinkle:true) and already keeps the loop running in sky view (loop.js:310).

**Proposal.** Give the per-channel modulation phase offsets that grow with airmass (Δφ_RGB ∝ X·(0, 0.9, 1.7)) and amplitude ∝ smoothstep(1.5, 40, F)·(1-sinAlt)², so only bright stars below ~20° flash colour. A few ALU ops in the vertex shader, no new uniforms beyond the existing uTime. High tier only; respects reduced motion through uTwinkle.

**Risks.** Easy to overdo: keep saturation modest and clamp so the hue never leaves the star's B-V gamut by more than about 30 %.

**Files.** `js/render/shaders/sky.glsl.js`

**Verifier evidence.** STAR_VERT twinkle (sky.glsl.js:104-111) modulates only `peak`, with two tones scaled by mix(1,0.3,sinAlt), so colour is fixed. Twinkle is high tier only (quality.js:37 twinkle:true), and loop.js:310-312 already keeps frames continuous while it runs. vColor is a per-star varying, so per-channel modulation costs a few vertex ALU ops.

## Lens: Bodies, beams, labels & post-processing

The bodies, beams and labels code is carefully built. Beam ribbons use exact projected lines and are NaN-safe under MSAA. The flare uses analytic occlusion. The Moon uses Lommel–Seeliger lighting and turns copper in a lunar eclipse. The biggest gap is that the planets themselves are never shown. A planet is a 3–12 px glyph sized by magnitude, and in globe view it is usually just a beam that leaves the screen, so selecting Saturn only brightens a beam. The total solar eclipse in sky view, a once-in-a-lifetime moment, renders as a sky-coloured disc with a featureless 0.2° Gaussian glow and the selection reticle stuck to the Moon's edge. The single biggest opportunity is one shared planet-impostor shader, using AE data that is already vendored but unused: RotationAxis poles, Illumination.ring_tilt and JupiterMoons. It would show phases, Saturn's rings at their true tilt, Jupiter's bands and the Galilean moons. It can drive beam-end planet medallions in globe view and a telescope zoom in sky view, alongside a proper totality: structured corona, Baily's beads, diamond ring. I A/B-tested AgX against ACES (bodies-tm-*-sbs.png). Without a full retune AgX looks washed out, so keep ACES.

### `totality-spectacle`: Total solar eclipse done right: structured corona, chromosphere, Baily's beads, diamond ring ★

*visual · impact 5→5 · effort L→L · verdict **revise** · tracked under `totality-sequence`*

**Pitch.** At second contact the last sliver of Sun breaks into Baily's beads and then a blazing diamond ring. It gives way to a pearly corona with long equatorial streamers and polar plumes around an inky Moon, with pink prominences on the limb. This is the most spectacular sky event there is, it is computed for the user's exact location, and it is the screenshot people will share.

**Current state.** The sky-view eclipse corona is a single radial exponential. SUN_ECL_CORONA_SCALE is 0.2° and SUN_ECL_CORONA_GAIN is 0.9 (js/render/bodies.js:36-40), coronaSky = smooth(0.985,1,obscuration) (bodies.js:399-404), and DISC_FRAG computes glow = exp(-r/uGlowScale) with no angular structure (js/render/shaders/bodies.glsl.js:30-51). At the default FOV (70–100°) the whole corona is about 2 px: eclipse-sky.png shows a dot plus the reticle. At FOV 5° (bodies-eclipse-sky5.png, bodies-crop-eclipse.png) you see a sky-coloured Moon disc inside a featureless grey haze. The reticle radius is sunR·pxPerRad+7px (bodies.js:478-480), which puts it about 3 px outside the Moon's limb, so it reads as a broken beige ring. The 'Sun' label dot sits inside the Moon's disc (labels-feed.js:54). There is no chromosphere, no prominences, no beads and no diamond ring. The Moon is drawn additively after a depth-only pass (bodies.js:252-277), so it cannot be darker than the sky.

**Proposal.** Add an eclipse branch to DISC_FRAG, gated by a uniform uTotality (0 outside obscuration > 0.9 in sky view, so normal frames cost nothing).
(1) Radial profile: the Baumbach K-corona law I(ρ) = 0.0532ρ^-2.5 + 1.425ρ^-7 + 2.565ρ^-17, with ρ in solar radii, mapped to HDR so that ρ≈1.05 is about 4 (it blooms) and ρ≈4 is about 0.02. Enforce a minimum on-screen corona radius of about 30 CSS px so totality reads at FOV 100°.
(2) Angular structure: 3–5 helmet streamers near the solar equator (Gaussian lobes in position angle whose width grows with ρ), a Ludendorff flattening term ε(date) (round near solar maximum in 2025, elongated near minimum), and polar plumes from 1D hashed value noise at about 60 lobes, weighted by a polar mask. Add fibrous texture from noise in (θ·N, log ρ). Seed the noise from the eclipse date so each eclipse looks different but stays stable. Orient everything with the Sun's pole position angle on screen from AE.RotationAxis(Body.Sun), which already resolves in the vendored engine.
(3) Contacts: pass uMoonOff (the Moon's centre offset from the Sun in the quad's tangent plane, from dirs[SUN] and moonDirCam, both already in bodies.js) and uMoonR. The photosphere shows only where |p−moonOff| > moonR + limb(θ). Here limb() is a ±2″ noise standing in for the lunar limb profile, so a sliver thinner than about 3″ breaks into beads. When the visible fraction f is in (0, 2e-3), add a starburst at sunCentre + normalize(−moonOff)·sunR with gain ∝ √f: the diamond ring.
(4) Chromosphere and prominences: a 1.5%-of-R☉ H-alpha ring (1.0, 0.25, 0.35) plus 3–5 seeded flame shapes at 2–6% R☉. They appear only where the Moon's limb uncovers them, which is naturally near C2 and C3.
(5) Reticle: during totality use a radius of 2.5·max(sunR, moonR) or corner brackets, and move the label outside the disc (see the label-offsets idea).
(6) Optional orbit-view companion: a faint umbra axis or cone from the Moon to the Earth's surface.
Add a pure contact-geometry helper (sliver width, bead PA) in js/astro/shadow.js with node tests. Low tier has no bloom, so draw the diamond-ring rays analytically in the shader. In text mode nothing changes.

**Risks.** The corona shape is illustrative, not a prediction (real ones come from MHD models that need the network), and the prominences are fictional; say so in About and ASTRONOMY.md. Contacts last seconds, so at fast rates the beads flash by; pair this with a UI 'slow to real time near C2/C3' action (UI lens). At FOV 5° the 6° Sun quad fills the screen, so the corona fragment shader runs full-screen: keep it to about 40 ALU ops and gate it by uTotality. The 360° horizon glow and the darker totality sky belong to the sky/ground lens, and the black-disc look depends on them. About +5 KB raw JS against the low tier's 90 KB headroom. No textures, no per-frame allocation (all uniforms preallocated).

**Files.** `js/render/bodies.js`, `js/render/shaders/bodies.glsl.js`, `js/astro/shadow.js`, `js/app/labels-feed.js`, `test/astro.shadow.test.mjs`

**Verifier evidence.** The cited current state is accurate. bodies.js:36-40 sets SUN_ECL_CORONA_SCALE to 0.2° and the gain to 0.9. bodies.js:403 has coronaSky = smooth(0.985,1,obscuration). DISC_FRAG (bodies.glsl.js:39-50) is two radial exponentials with no angular term. The reticle is sunR·pxPerRad+7px (bodies.js:480). The Moon is a depth-only pass plus an additive colour pass (bodies.js:252-277). bodies-eclipse-sky5.png shows a sky-coloured Moon disc in a featureless grey haze, the 'Sun' label dot inside the disc, and the reticle hugging the limb. eclipse-sky.png at FOV ~70° shows only a dot and the reticle. grep finds no corona structure, beads or diamond ring anywhere. ground.js:7/17 already does the 360° totality horizon glow, which belongs to the sky lens. In node, AE.RotationAxis('Sun') works in the vendored engine (ra 19.08 h, dec 63.87°).

**Verifier corrections.** (1) Per-pixel limb noise of ±2″ cannot make Baily's beads at the current 5° FOV floor, where 1 px ≈ 20″. The sliver is sub-pixel, so a shader version would alias or shimmer. Compute the contact geometry on the CPU instead: the Moon–Sun offset from dirs[SUN] and moonDirCam, the sliver width, and 3–6 bead position angles along the uncovered arc. Draw the beads as a few HDR point sprites; the instanced GLYPH path or flare element 0's starburst repositioned to the bead PA both work. Bloom then does the rest at any FOV, and the low tier gets analytic rays. (2) bodies.js may not call AE. Put the Sun's pole (AE.RotationAxis('Sun').north mapped through S) in the snapshot at 'full' detail and project it to a screen-space PA in DISC_VERT. (3) Blend the new corona into the existing coronaSky/SUN_ECL_* path and the skyViewExposure adaptation instead of adding a parallel gain. (4) DISC_FRAG is shared with the Moon aureole, so use a #define or a separate material for the eclipse branch. (5) The 30-CSS-px minimum corona is a stylised inflation, about 2.5× the true 4 R☉ extent at FOV 70°. Document it like the glyph inflation. The rest of the plan (Baumbach profile, seeded streamers and plumes, an H-alpha rim near C2/C3, a larger reticle in totality) is sound.

### `planet-impostor-medallions`: Real planets at the end of every beam: phase-correct mini-globes with Saturn's rings at today's tilt ★

*visual · impact 5→4 · effort L→L · verdict **revise***

**Pitch.** Each beam ends in a small, lit, magnified planet instead of a coloured dot. Venus shows as a 4% crescent today, Saturn's rings are tipped at 6.5° and casting a shadow, Jupiter shows its belts, Mars shows its real central meridian. The globe view becomes a live orrery postcard and selecting a planet finally shows the planet.

**Current state.** Planets are 7 instanced glyph quads at infinity (js/render/bodies.js:178-205), sized 3–12 px and brightened only by magnitude (bodies.js:94-97). GLYPH_FRAG draws a crisp disc, halo and optional spikes (js/render/shaders/bodies.glsl.js:82-110): no phase, orientation, rings or surface. In orbit view the beam fades out toward an off-screen glyph (beam.glsl.js:180-182), and the label sits at the beam's screen exit (beams.js:342-421) with a 6-px CSS dot (css/app.css:179-186). Selecting Saturn only brightens its beam (bodies-sel-saturn-globe.png). The vendored AE already has RotationAxis for every planet, Illumination().ring_tilt and JupiterMoons, but only the Moon's RotationAxis is used (js/astro/snapshot.js:320). Checked with AE for 2026-11-03: Venus phase 0.042, Saturn ring tilt 6.51°, Io hidden behind Jupiter.

**Proposal.** New render module js/render/planets.js plus shaders/planets.glsl.js, registered in importRenderStack and the create(...) list in main.js. One instanced quad per planet.
In orbit view each quad is placed at beams.labelAnchor(id): a world point projected to screen, about 26 CSS px, or 40 px when selected with a thin ring. The fragment shader ray-traces an oblate spheroid impostor (flattening: Jupiter 0.065, Saturn 0.098), oriented by the pole and lit from L = normalize(sunDir·dSun − planetDir·dP) built from the snapshot's dirS/distAU (per-planet distance in scene units: Mars 0.5–2.5 AU vs the Sun's 1 AU), which gives the phase and bright-limb angle exactly.
Shading per planet:
- Mercury: Lommel–Seeliger reused from MOON_FRAG.
- Venus: Lambert plus a soft haze terminator.
- Mars: a 512×256 albedo lookup at the AE spin angle (public-domain Viking/MOLA mosaic, about 25 KB, lazy).
- Jupiter and Saturn: a 64-entry latitude band table plus turbulence noise and the Great Red Spot.
- Saturn's rings: an analytic ray–plane hit with a radial opacity table (C, B, Cassini division, A), the planet's shadow on the rings and the rings' shadow on the globe.
- Uranus and Neptune: limb-darkened tinted discs; Uranus's 98° pole shows.
Add to the snapshot (pure, at the 'full' 4 Hz detail) a per-planet poleS: Float64Array(3) from AE.RotationAxis(body).north mapped through S. Body labels get a has-medallion class that hides .lbl__dot and shifts the text. Low tier: a flat Lambert phase disc with no bands or noise. Text mode: unchanged (body card).

**Risks.** This deliberately shows planets magnified, not at true scale. Make that explicit (an 'eyepiece' ring style, tooltip 'magnified'). About 8–10 KB of raw JS/GLSL counts on the low tier (90 KB headroom). The Mars texture must load lazily and stay out of tierTextureKeys, or it eats the budget; a procedural fallback is required. Bands and the GRS longitude are approximate (the GRS drifts in System II; document that). Medallions must follow labels' NaN-until-landed rule so the intro choreography still works. Uniform arrays are preallocated (R5); every fragment shader ends with the tonemapping and colorspace includes.

**Files.** `js/render/planets.js`, `js/render/shaders/planets.glsl.js`, `js/astro/snapshot.js`, `js/core/types.js`, `js/main.js`, `js/render/labels.js`, `css/app.css`, `js/render/textures.js`

**Verifier evidence.** Planets are instanced glyph quads with only a crisp disc, halo and spikes (bodies.js:178-205, bodies.glsl.js:82-110). The size and intensity clamps are at bodies.js:95-97. The beam fades into the glyph (beam.glsl.js:180-182), and the label dot is 6 px (app.css:179-186). No planet surface, phase or ring rendering exists in the scene. The UI body card already draws a 64-px canvas phase disc (body-card.js:63, 264-269), but only in the panel. In node against the vendored AE for 2026-11-03: Saturn ring_tilt is 6.51°, Venus phase_fraction 0.042, and RotationAxis('Jupiter') resolves. Only RotationAxis('Moon') is used (snapshot.js:320).

**Verifier corrections.** (1) Beam labels are de-overlapped with ~20-px-tall boxes (beams.js LABEL_HALF_H = 10, LABEL_LEFT = 6, separateLabels at :489). A 26–40-px medallion at labelAnchor(id) will collide whenever beams are near-parallel, as Saturn and Neptune are in bodies-moon-orbit30.png. Feed each medallion's footprint into rightExtent/boxAt, or the separation logic, so anchors slide back far enough. (2) Reuse the body card's phase math, or share one pure helper, so the panel disc and the 3D medallion never disagree. (3) Poles can go in at 'full' (4 Hz) detail, since they barely change. Light direction is fine from dirS·distAU. (4) Keep Mars's albedo map lazy and out of tierTextureKeys, as the proposal already says. Low tier has 90 KB of headroom (check-size: 3.71 of 3.80 MB), so watch the ~10 KB of JS and GLSL.

### `telescope-zoom`: Telescope zoom in sky view: dive from the whole sky into Jupiter and its moons ★

*feature · impact 5→4 · effort L→XL · verdict **revise***

**Pitch.** Pinch on Jupiter in sky view and keep going. The star field opens up, the four Galilean moons line up, and Jupiter's banded disc fills the screen at its true size and orientation for this minute; Saturn's rings and Venus's crescent work the same way. It is the 'point a telescope at it' moment, all offline.

**Current state.** Sky-view FOV is clamped to 5° (js/camera/rig.js:42 SKY_FOV_MIN = 5). At 5° on a 900-px viewport, Jupiter's 18.1″ radius (AE, 2026-11-03) is 0.9 px, so it can only ever be a magnitude glyph with spikes and a reticle (bodies-jupiter-sky5b.png). The Moon at 5° is about 90 px and already convincing (bodies-moon-sky5.png), but its texture is 1024² (js/render/textures.js:28).

**Proposal.** Lower SKY_FOV_MIN to 0.05° (Jupiter's radius then becomes about 90 px) with log-scaled wheel and pinch zoom (rig.js:881, :834 already multiply exponentially). In bodies.js, compute each planet's true angular radius (equatorial radius ÷ distance). When it exceeds the glyph's core size in px, cross-fade that instance to the planet-impostor shader from the medallion idea, at true scale and orientation.
At 'frame' detail add the Galilean moons (see that idea), visible as real discs below 0.3° FOV, with transit shadows (the impostor already intersects the Sun ray) and occultations. Stars: the PSF already scales with uZoom (sky.js:505, capped at 2.5), so add a mag-limit boost with zoom (aperture gain) so that zooming reveals fainter stars. Float32 unit-vector precision is about 0.012″ (1 px is 0.2″ at 0.05°), so infinityClip (sky.glsl.js:16-21) holds.
Moon: lazy-load a 2k/4k public-domain texture (NASA SVS CGI Moon Kit) when FOV < 2°, outside the tier budgets. Low tier keeps the 5° limit (or 1°), and text mode is unaffected.

**Risks.** Depends on the planet-impostor shader. Camera-lens owners need to agree on zoom UX and the url-state clamp (rig.js:157 clamps cam=s:…). At tiny FOV the star catalog (5,000 stars to mag 6.5) looks empty, so be clear that the deep-sky background is not modelled. The lazy Moon texture adds about 0.6–1.5 MB to staging (6.53 of 12 MB used) but not to tier budgets. No atmospheric seeing or refraction distortion at high magnification, which is acceptable.

**Files.** `js/camera/rig.js`, `js/render/bodies.js`, `js/render/shaders/bodies.glsl.js`, `js/render/sky.js`, `js/render/textures.js`, `js/astro/snapshot.js`

**Verifier evidence.** SKY_FOV_MIN = 5 (rig.js:42), and clamps at rig.js:157, 603, 834, 881 and 1015. url-state.js:30 also clamps fovMin to 5, and url-state.js:204 serialises the FOV with one decimal (fmtNum(fov,1)). Moon texture is 1024² (textures.js:28). The star PSF zoom is capped at 2.5 (sky.js:507). The sky camera is an alt/az look controller (rig.js:214 sky {az,alt,fov}). It has no tracking: grep for track/follow in rig.js finds only Earth-lock for the orbit view.

**Verifier corrections.** (1) The proposal misses that the view needs to track the target. Sky view is fixed in alt/az, so at 0.05° FOV diurnal motion (15″/s, 1 px ≈ 0.2″) moves Jupiter ~75 px/s at rate 1, and any fast rate flings it off-screen at once. Add a 'track selection' mode in rig.js that recentres on the selected body's dirS each frame below ~2° FOV. (2) url-state needs fovMin lowered and more FOV precision, or cam=s:… deep links break. (3) It depends on the planet-impostor shader and the Galilean moons, plus lazy Moon and Mars textures, so the effort is XL, not L. (4) Consider a 0.2–0.5° floor first, where Jupiter is ~10–20 px and the moons spread out, before going to 0.05°.

### `galilean-moons`: Jupiter's four Galilean moons, live from AE.JupiterMoons

*feature · impact 4→3 · effort M→M · verdict **revise***

**Pitch.** Zoom toward Jupiter and four tiny stars appear beside it, Io, Europa, Ganymede and Callisto, in exactly tonight's arrangement, hiding behind Jupiter and reappearing as time runs. It is what binoculars show, and the data is already vendored.

**Current state.** Only the 7 planet glyphs are instanced (js/render/bodies.js:25, 182-191, glyphGeo.instanceCount = N_PLANETS). AE.JupiterMoons exists in vendor/astronomy-engine/astronomy.js:3568 and is never called (grep finds no use in js/). AE for 2026-11-03T22:00Z: Callisto 7.9′, Ganymede 1.65′, Europa 2.8′ (behind) from Jupiter, Io 0.16′ (occulted). At today's 5° minimum FOV, Callisto is about 24 px from Jupiter and Ganymede about 5 px, so the moons are visible but sit inside the glyph halo. The FOV floor is rig.js:42.

**Proposal.** In js/astro/snapshot.js at 'frame' detail, compute AE.JupiterMoons(t − lightTime). Take Jupiter's light-time from the eq.dist the snapshot already uses (snapshot.js:252); without it Io's position is off by about 11°. Write jupiterMoonsS = Float64Array(12) as directions in the scene frame (Jupiter's geocentric vector plus each moon offset, then S·), and occulted/transit flags (line-of-sight depth sign and projected separation < R_J). Add a pure test against AE.
In bodies.js, grow the glyph instances to N_PLANETS + 4: magnitudes about 5.0–5.7, a neutral colour, hidden when occulted, and faded out with FOV > 8° so they never clutter the wide sky. Labels come from labels-feed as 'star'-kind anchors with a gate on camera FOV < 3°. Lower SKY_FOV_MIN to 1° (Callisto about 120 px out) even before the full telescope zoom. Low tier: same (4 extra instances). Text mode: optionally a line in the Jupiter body card listing the moons east and west.

**Risks.** About 2 KB of JS. JupiterMoons runs every frame-detail snapshot (cheap, about 4 series evaluations). Must stay pure and import AE only through js/astro/ae.js. Positions use EQJ and are jovicentric, so add to Jupiter's astrometric vector before mapping. A sign error would put the moons on the wrong side; test the elongation sign against a known date.

**Files.** `js/astro/snapshot.js`, `js/core/types.js`, `js/render/bodies.js`, `js/render/shaders/bodies.glsl.js`, `js/app/labels-feed.js`, `js/camera/rig.js`, `test/astro.snapshot.test.mjs`

**Verifier evidence.** grep finds no JupiterMoons use in js/ or test/. It exists at vendor/astronomy-engine/astronomy.js:3568. Glyph instanceCount = N_PLANETS (bodies.js:191). In node for 2026-11-03T22:00Z, Jupiter is 5.456 AU away (light time 45.4 min). Over the light time, the moons' jovicentric directions turn Io 6.37°, Europa 3.18°, Ganymede 1.59° and Callisto 0.67°.

**Verifier corrections.** (1) Without light-time, Io's error is ~6°, not '~11°'. It is still worth correcting. (2) Do not reuse the planet glyph path as is. glyphIntensity clamps to at least 0.6 (bodies.js:97), so mag-5.5 moons would draw as bright as a mag-1.5 object, and the crisp 3-px disc is the 'planet' style. Give the moons their own intensity from magnitude, or render them through the star PSF formula (sky.glsl.js star vertex shader). (3) Also hide moons in Jupiter's shadow (eclipses), not only occultations. (4) A lower FOV floor also needs url-state.js:30/169/204, not only rig.js:42. (5) At 5° FOV Ganymede sits inside Jupiter's glyph halo (ext = R·6.5 with spikes), so this is only worthwhile with the FOV change.

### `retrograde-timelapse`: Retrograde loop as a time-lapse composite: weekly planet images that swell toward opposition ★

*visual · impact 4→3 · effort M→M · verdict **keep***

**Pitch.** Select Mars with Trails on and you get the famous astrophoto composite: a chain of Mars images every week tracing the loop through Leo, growing from a faint dot to a blazing −1.2 mag disc at the Feb 2027 opposition. The geometry of retrograde motion becomes obvious at a glance.

**Current state.** The trail is a 0.9-px polyline with past/future styling, month ticks and station rings (js/render/trails.js:54-60, 99-213). It looks good (bodies-mars-trail-sky2.png), but it carries no brightness or size information and no sense of the planet's position on each date. The path comes from apparentPath in the almanac worker (js/astro/worker.js:51, js/astro/paths.js:56) with daily directions only. Month labels such as 'Mar' collide with star names (Algieba) in the same shot.

**Proposal.** In the worker, extend apparentPath's result with a weekly Float32Array of magnitude and angular diameter: AE.Illumination at each 7-day sample, about 52 calls, done once per selection. In trails.js, add an instanced 'ghost' glyph layer of at most 64 instances sharing GLYPH_VERT/GLYPH_FRAG. Size and brightness come from that date's magnitude via glyphSizePx and glyphIntensity (bodies.js:95-97); past images are slightly desaturated and the opposition sample gets a small date tag. Allocate the buffers in show() and only rewrite them on reselect (R5). Give month labels lower priority than star names, or show only the four labels at stations and opposition. Low tier: cap at 26 instances. Text mode: the body card already lists the stations.

**Risks.** About 2–3 KB. Worker messages grow by about 400 bytes. Make sure the additive ghosts do not trip bloom into a smear when several bright samples overlap near the stations (cap the per-instance intensity). Worker code must stay pure.

**Files.** `js/astro/paths.js`, `js/astro/worker.js`, `js/render/trails.js`, `js/render/bodies.js`

**Verifier evidence.** trails.js:54-60 is a 0.9-px line layer with month ticks and station rings. paths.js apparentPath returns only tMs, dirS and eclLonDeg, with no magnitude or size per sample. worker.js OPS.path wraps it. bodies-mars-trail-sky2.png shows the narrow 2027 Mars loop, and the 'Mar' tick label collides with Algieba. GLYPH_VERT and GLYPH_FRAG are exported from bodies.glsl.js, so trails.js can share them.

**Verifier corrections.** With the glyphSizePx/glyphIntensity clamps (3–12 px, 0.6–3.0), Mars only grows from ~3 to ~7 px across the cycle, and Jupiter and Saturn barely change. Drive size from angDiam (log-scaled) as well as magnitude. The 2027 loop is very narrow at default FOV, so weekly ghosts will pile up near the stations: skip samples closer than ~1.5 glyph diameters on screen, or use 10–14-day spacing. The month-label versus star-name priority fix is a cheap win on its own.

### `daylight-label-hygiene`: Hide invisible stars' names by day and stop the 'embossed' dark halos on bright skies

*ux-polish · impact 4→3 · effort S→S · verdict **revise** · tracked under `daylight-label-policy`*

**Pitch.** The daytime sky view becomes clean and believable: only the Sun, Moon and visible planets are labelled, in crisp text that suits a blue sky. Star and constellation names fade back in at twilight, or during totality.

**Current state.** Star and constellation anchors are always built (js/app/labels-feed.js:134-167), and labels.js hides them only below the horizon (js/render/labels.js:383-386). The label text shadow is a triple dark halo tuned for night (css/app.css:187-189). On the Paris noon sky it prints OPHIUCHUS, LIBRA, Antares, Menkent and others in dark-outlined 'embossed' type over a pale blue sky with no visible stars (sky-day-paris.png, bodies-crop-daylabels.png). The data to fix this already exists: exposureFor gives stars = 1 − smoothstep(−18, −4, sunAlt) (js/astro/photometry.js:195-206), and sky.js adds the totality term (sky.js:509-510).

**Proposal.** In js/app/loop.js:157 and :349-352, add starVis = max(exposure.stars, eclipseStars) and skyLum = 1 − skyViewExposure(...) (a 0–1 brightness proxy) to the reused labelOpts object (no allocation).
In labels.js project(), skip 'star' and 'constellation' kinds when opts.starVis < 0.12, with a CSS opacity ramp driven by a per-root custom property.
Write --sky-lum on #labels-root, quantised to 0.05 and only written when it changes (no per-frame DOM churn). In CSS, scale the dark text-shadow alphas by (1 − var(--sky-lum)) and switch to a soft light halo and slightly darker text above about 0.5.
Totality brings starVis up, so names return automatically during an eclipse. Low tier: same. Text mode: not applicable.

**Risks.** Keep the labels.js API backward compatible, since opts fields are optional. Tests that count labelsVisible in daytime sky view would change. The thresholds should match the star shader's visibility (sky.glsl.js:88-90) so a name never shows without its star.

**Files.** `js/app/loop.js`, `js/render/labels.js`, `css/app.css`

**Verifier evidence.** Star and constellation anchors are always built (labels-feed.js:134-167). labels.js:385-386 hides them only below the horizon. The text shadow is a triple dark halo (app.css:187-189). sky-day-paris.png at Sun +25.7° prints OPHIUCHUS, LIBRA, Antares, Menkent and others in dark-outlined type over a pale sky with no stars visible. labelOpts is a reused object (loop.js:156). exposureFor is at photometry.js:195-206, and the totality term is at sky.js:509-510.

**Verifier corrections.** (1) A single starVis < 0.12 cutoff contradicts the star shader. The shader's limiting magnitude is lim = mix(−1, uMagLimit, sqrt(e)), with vis = smoothFall(lim+0.35, lim−0.45, mag) (sky.glsl.js:87-90). At e = 0.12, stars brighter than mag ~1.4 still draw, so their names would vanish while the stars show. Gate each star name by its own magnitude against that same lim, and gate constellation names on a higher e (~0.3). (2) 1 − skyViewExposure is not a 0–1 sky brightness: it peaks at 0.65 (sky.js:41). Derive --sky-lum from smooth(−6, 10, sunAlt) × (1 − totality) instead. (3) The quantised CSS variable and the light halo by day are good as proposed.

### `label-reticle-offsets`: Keep labels outside discs and reticles; fix the eclipse reticle hugging the Moon

*ux-polish · impact 3→3 · effort S→S · verdict **keep***

**Pitch.** Selecting Jupiter or zooming onto the Moon no longer puts the name's dot on top of the reticle or inside the lunar disc. The selected-body framing looks deliberate instead of collided.

**Current state.** Every body label uses a static GLYPH_OFFSET of [7, −7] px (js/app/labels-feed.js:54, applied at :90-93). The selection reticle has a 14-px radius (js/render/bodies.js:46), or disc+7 px for the Sun and Moon (bodies.js:478-480). So the selected label's dot sits on the reticle ring (bodies-jupiter-sky5b.png). At narrow FOV the 'Moon' and 'Sun' labels sit inside their discs (bodies-moon-sky5.png, bodies-crop-eclipse.png). At totality the Sun's reticle is computed from the Sun's radius, so it lands about 3 px outside the larger Moon's limb and reads as a broken beige ring.

**Proposal.** bodies.js keeps a live Float64Array labelRadiusPx[BODIES.length] = max(glyph core px, disc radius px (sunR or moonAngR × pxPerRad), reticle radius if selected) + 4·dpr, divided by dpr to give CSS px. It is exposed as bodies.labelRadius(id).
In labels-feed, give each body anchor its own offsetPx array (allocated once in rebuild) and rewrite it in sync() as [r·0.707, −r·0.707]. labels.js already reads offsetPx every frame (labels.js:388-390), so there is no allocation.
For the Sun's reticle while the Moon overlaps it, use max(sunR, moonR at sep < sunR + moonR) for the radius. At obscuration > 0.98 in sky view, use 2.5× that radius (outside the inner corona) or switch to four corner brackets in RETICLE_FRAG.
In orbit view, beam anchors already avoid overlap, so leave them unchanged.

**Risks.** Cross-module plumbing: labels-feed gets a getBodies() dependency like getBeams. It must stay allocation-free in sync(). Recheck the label declutter test fixtures.

**Files.** `js/render/bodies.js`, `js/render/shaders/bodies.glsl.js`, `js/app/labels-feed.js`, `js/main.js`

**Verifier evidence.** GLYPH_OFFSET = [7, −7] (labels-feed.js:54) applies to every body in sky view (:90-93). RETICLE_PX = 14 (bodies.js:46), and the Sun and Moon reticles are disc + 7 px (:479-480). bodies-jupiter-sky5b.png shows Jupiter's label dot on the reticle ring. bodies-moon-sky5.png shows the 'Moon' label inside the lunar disc. bodies-eclipse-sky5.png shows the 'Sun' label inside the Moon and the reticle hugging the larger Moon limb. labels.js:388-390 reads offsetPx live every frame.

**Verifier corrections.** There is a simpler plumbing option with no getBodies() dependency. labels-feed.sync() already has the camera and the snapshot, so it can compute r = max(glyph radius, (angDiamArcsec/2) in px via camera.projectionMatrix, the reticle radius if selected) + 4 px into per-anchor Float64Array(2) offsets allocated in rebuild(). In the totality reticle fix, reticle radius = max(sunR, moonR) when they overlap.

### `below-label-mismatch`: Bug: body label says 'below horizon' while its beam is drawn above (refraction/limb mismatch)

*bug · impact 2→2 · effort S→S · verdict **revise***

**Pitch.** Around every sunrise and sunset, and moonrise and moonset, the Sun's beam is solid and bright but its label turns dim italic 'below'. That contradicts the beam and the Sky panel for several minutes each day.

**Current state.** Beams decide 'below' with the snapshot's refraction- and limb-aware st.above (js/render/beams.js:244-246). Labels use the geometric altitude: labels-feed.js:80 and :355 call isBelow(st.altGeomDeg), and labels.js:410-414 uses dirS·upS < 0 for dirS anchors in sky view. Repro: #loc=48.85,2.35&n=Paris&tz=Europe/Paris&t=2026-11-03T16:26:00Z&p=0&intro=0. The snapshot gives Sun {above:true, altGeomDeg:−0.66, altDeg:−0.07}, the beam is solid, and .lbl[data-id=sun] has class 'is-below' (bodies-sunset-label-small.png).

**Proposal.** Add an aboveFlag helper: typeof st.above === 'boolean' ? !st.above : isBelow(st.altGeomDeg). Use it in bodyAnchors (labels-feed.js:80) and in sync() (:355). In labels.js project(), stop recomputing belowNow from the geometric dot product for body anchors that carry a `below` flag; prefer a.below and fall back to the dot product only when a.below is undefined. Add a labels-feed unit test using a snapshot with above:true and altGeomDeg < 0.

**Risks.** None material. Check that the Sky panel's UP/DOWN chips use the same flag, so all three agree (UI lens).

**Files.** `js/app/labels-feed.js`, `js/render/labels.js`, `test/app.labels-feed.test.mjs`

**Verifier evidence.** Reproduced in orbit view at #loc=48.85,2.35&t=2026-11-03T16:26:00Z. The eval returned Sun {above:true, altGeom:−0.658, alt:−0.071} with .lbl[data-id=sun] class 'lbl lbl--body is-below' (shots/bv-sunset-label.png). The beam is solid, and the Sky panel lists Sun and Mercury as UP, while both labels are dim italic. Beams use st.above (beams.js:246), the Sky panel uses b.above (sky-now.js:50), and labels use altGeomDeg (labels-feed.js:80, :355).

**Verifier corrections.** Do not switch to `above` blindly in sky view. Rendering applies no refraction: grep finds 'refract' nowhere in js/render or js/camera, and bodies are drawn at the unrefracted dirS. At this instant the sky-view Sun disc (centre −0.66°, radius 0.27°) is drawn fully under the ground, so the geometric 'below' label matches what is drawn there. Use `above` in orbit view, where beams already do. For sky view, either keep the geometric flag or, better, add a refraction lift to rendered body directions near the horizon (refractionDeg from the snapshot), so the drawn disc, the label and the panel all agree. That would also give flattened, lifted sunsets. Also note that in sky view body anchors carry posS from beams.labelAnchor, so labels.js:410-414's dirS branch is only the fallback.

### `procedural-flare`: Procedural lens flare: clean aperture ghosts instead of muddy textured discs (and −68 KB)

*visual · impact 3→2 · effort M→M · verdict **keep***

**Pitch.** When the Sun rises over the limb you get a crisp, cinematic flare: a fine six-blade starburst and a few clean hexagonal ghosts with faint spectral rims. The dark-rimmed green and grey blobs that look like dirt on the lens go away.

**Current state.** js/render/flare.js:15-21 draws a starburst (lensflare0.png, 64 KB) and 4 ghosts from lensflare3.png. That texture peaks at 37/255, so it needs a ×6 gain (flare.js:80-82), and ghostHue tints the ghosts green, blue, magenta and amber (bodies.glsl.js:275-298). On screen the ghosts read as muddy green and grey dark-rimmed discs over the night side (bodies-sel-saturn-globe.png, crop bodies-crop-ghosts.png) and as a pink ring on the daytime ground (bodies-crop-daylabels.png). The two textures cost 68 KB on the medium and high budgets (textures.js:29-30; check-size medium 4.19 of 4.30 MB).

**Proposal.** Replace FLARE_FRAG's texture lookups with analytic shapes.
Starburst: a core exp(−r/σ) plus 6 (or 12) thin rays, ray(θ) = pow(|cos(3θ)|, 400) × exp(−r/len), and a faint spectral 'iris' ring (per-channel radius offset).
Ghosts: a regular-hexagon SDF (the aperture), with a smooth interior, a 1.5-px brighter rim and per-channel scaled radius for chromatic fringing. Use 4–6 ghosts at classic axis positions with sizes that scale with viewport height. Scale ghost intensity by vis² and by the Sun's distance from screen centre, so ghosts shrink and dim as the Sun nears the axis, as a real lens does.
Keep the existing analytic occlusion and tinting (flare.js:128-203). Remove flare0 and flare3 from ASSETS and keyed loading (textures.js:29-30, :89) and from check-size FALLBACK_ASSETS. Low tier: flare stays off. Text mode: not applicable.

**Risks.** Purely aesthetic, so tune it on a real GPU. It frees about 68 KB on the medium and high budgets, headroom that lazy planet or Moon textures could use. The vendor/credits list in About may mention the three.js flare textures; update it.

**Files.** `js/render/flare.js`, `js/render/shaders/bodies.glsl.js`, `js/render/textures.js`, `scripts/check-size.mjs`, `docs/ARCHITECTURE.md`

**Verifier evidence.** flare.js:15-21 has one starburst and four ghost elements. uGhosts = 6 compensates for lensflare3.png peaking at 37/255 (flare.js:80-82). ghostHue is green, blue, magenta and amber (bodies.glsl.js:275-282). bodies-crop-ghosts.png shows two dark-rimmed muddy green and grey discs over the sky and limb. The textures are 65,361 B and 3,112 B (assets/textures). check-size shows medium at 4.19 of 4.30 MB and high at 5.24 of 5.40 MB, both loading flare0 and flare3.

**Verifier corrections.** A ghost over the ground is not itself a bug. Ghosts are internal reflections mirrored through the screen centre, so they land wherever the axis goes. The real problem is the muddy texture look. Do not dim the ghosts as the Sun nears the axis. Real ghosts converge and stack near the centre rather than fading, so scale them by vis and limb transmittance as now and keep the position law. Also update readAssets/FALLBACK_ASSETS and tierTextureKeys in check-size.mjs, and keysForTier in textures.js:89.

### `orbit-hierarchy`: Orbit-view hierarchy: beams thin with zoom, selection keeps its colour, constellation lines recede

*ux-polish · impact 3→2 · effort S→S · verdict **revise***

**Pitch.** Zoomed out, the Earth stays the hero instead of being crossed by lightsaber bars wider than the planet. A selected beam reads as 'that colour, brighter', not a blown-out white bar. Constellation figures sit quietly behind the beams.

**Current state.** Beam half-width is the tier's beamGlowPx × dpr whatever the camera distance (js/render/beams.js:198-201, 291-298). A selected beam gets 1.4× width (beam.glsl.js:62), a 2.6-px core (:172) and 1.6× intensity (:204). At camera distance 30 ER the selected Moon beam is a roughly 40-px white bar, wider than the 70-px Earth, and ACES has removed its hue (bodies-moon-orbit30.png). Constellation lines draw at alpha 0.28 in orbit view (js/render/sky.js:312-313, 527) and compete with the beams (intro-5000.png, globe.png).

**Proposal.** In beams.update(), uGlowPx = glowPx·dpr·clamp(sqrt(3.4/|camPos|), 0.45, 1.0), using the default camera distance as the reference. For the selected beam, drop the 1.4× width and add core intensity instead. Before the final multiply, apply a hue-preserving cap: c *= min(1, 4.0/max(c.r, c.g, c.b)), so ACES does not wash the selected colour to white (bloom still triggers above the 0.9 threshold). In sky.update(), constellation alpha = mix(0.16·clamp(4/camDist, 0.4, 1), 0.28, skyBlend), with the highlight kept at full strength. All of this is uniforms only; nothing is allocated.

**Risks.** Taste-sensitive: it changes the signature look slightly, so A/B with the owner. Beam label anchoring uses LABEL_* px constants, not the glow width, so it is unaffected.

**Files.** `js/render/beams.js`, `js/render/shaders/beam.glsl.js`, `js/render/sky.js`

**Verifier evidence.** uGlowPx = glowPx·dpr regardless of camera distance (beams.js:291-298). A selected beam gets halfW ×1.4 (beam.glsl.js:62), a 2.6-px core and k ×1.6. bodies-moon-orbit30.png confirms the selected Moon beam is a bar wider than the ~70-px Earth at 30 ER. Constellation alpha is 0.28·max(e, 0.15) (sky.js:312, 527).

**Verifier corrections.** Drop the hue-preserving cap. Its evidence is wrong: the Moon's beam colour is #d8dde6 (bodies.js:38 in astro/bodies.js), already near white, so ACES removed no hue. bodies-sel-saturn-globe.png shows a selected Saturn beam that stays clearly gold. Keep the distance-scaled glow width, which is the real problem when zoomed out. Make the selection read through core intensity rather than the 1.4× width. Constellation dimming in orbit view is taste; A/B it before changing.

### `eclipse-aware-pin`: Eclipse-aware pin: get out of the umbra's way and mark the racing shadow

*ux-polish · impact 3→3 · effort M→M · verdict **keep***

**Pitch.** During a solar eclipse the pin's 1,400-km horizon disc steps aside to a thin rim, and a crisp ring marks the Moon's umbra with an arrow showing which way it races. At default zoom you can watch the shadow sweep across Luxor.

**Current state.** The Earth shader renders the Moon's shadow correctly (js/render/shaders/earth.glsl.js:181-187, 231). But the 0.22-ER horizon disc (js/render/pin.js:31) with a 0.18-alpha fill, rim and ticks (pin.js:103-104), plus the halo and foot glow, sits exactly over it. At default zoom the roughly 10-px umbra at Luxor is invisible (eclipse-luxor.png) and only shows at 1.6 ER (globe-eclipse-close.png). pin.js has no eclipse awareness at all (grep 'eclipse' finds nothing).

**Proposal.** In pin.apply(snap), read snap.eclipse.solar and obscurationAtObserver. When a solar eclipse is in progress, ease the disc uniforms to rim and ticks only (fill × 0.15) and the halo to 50%.
Add a pure helper umbraOnEarth(moonPosS, sunDirS, out) in js/astro/shadow.js: intersect the shadow axis from the Moon with the unit sphere, then compute the umbra and penumbra radii from cone geometry. Unit-test it against the 2027-08-02 path at Luxor.
In the pin group, draw a small 'shadow marker': a dashed ring (reusing the disc shader's tick math) at the umbra radius on the surface, and a chevron along the umbra's ground velocity (the difference of two cached centres; no allocation).
Low tier: the same, since it is cheap. Text mode: the Sky panel already says 'Total solar eclipse'.

**Risks.** Pure module discipline: shadow.js must stay three-free. The marker is placed in the Earth group's local frame, so convert with the inverse earthMatrix once per apply, not per frame. Coordinate with the globe lens if it plans its own umbra rendering.

**Files.** `js/render/pin.js`, `js/astro/shadow.js`, `test/astro.shadow.test.mjs`

**Verifier evidence.** grep finds no 'eclipse' or 'umbra' in pin.js. DISC_R = 0.22 (pin.js:31), and the fill/rim/ticks alphas are at pin.js:103-104. The earth shader computes sunVis from the Moon (earth.glsl.js:181-187) and even raises city lights in the umbra (:231). eclipse-luxor.png shows no visible shadow under the pin disc, beams and halo. globe-eclipse-noui.png at the same instant with the UI hidden shows a clear dark umbra or penumbra and the Nile city lights around Luxor. So the rendering already exists and only the pin hides it. shadow.js has no ground-track helper (exports lunarEclipseLight, discVisibleFraction, solarObscurationAt).

**Verifier corrections.** Most of the value is the S-sized part: ease the disc fill and halo down when snap.eclipse.solar and obscurationAtObserver > 0. The beams' glowIn near the origin also covers the spot and could be eased. Treat the umbra ring and velocity chevron as a second step. Compute the chevron from two snapshot-time umbra centres cached in apply(), not per frame.

### `true-light-time-pulses`: Light-time pulses that mean something: true speed of light on the Moon beam, distance-coded elsewhere

*feature · impact 3→1 · effort M→M · verdict **reject***

**Pitch.** At real-time rate a photon packet crawls up the Moon beam in 1.3 s at the true speed of light, the only place in the app where light moves at its real speed. When time runs fast, Neptune's pulses visibly lag Mercury's, so you can feel the distances.

**Current state.** Every beam pulses identically: phase = log(1+d)·0.9 + uPhase, with PULSE_HZ = 0.6 for all bodies (js/render/shaders/beam.glsl.js:165-187, js/render/beams.js:42, 300-310). Pulses show only when the clock runs faster than real time (js/app/loop.js:325). The snapshot already carries lightTimeS per body (js/astro/snapshot.js:252), and the body card prints it (js/ui/body-card.js:195-198), but the beams ignore it.

**Proposal.** Add a per-instance attribute iLight = (lightTimeS, period) written in beams.apply, with no allocation. On the CPU, period = clamp(lightTimeS/|rate|, 0.35 s, 8 s). Keep a per-body phase in a Float64Array advanced by dt/period, so there is no float drift.
In the shader, the pulse front sits at fraction (1 − phase) of the light path. For the Moon's finite beam, map that fraction linearly in distance, which is literally c (47 ER/s) at rate 1. For beams at infinity, map it along the existing log(1+d) coordinate, so slower pulses mean farther bodies.
Also enable pulses at rate 1 for the Moon beam only, when selected. Reduced motion: off, as now. Low tier: same (uniforms only).

**Risks.** Instance attribute count grows from 6 to 7. At high rates Mercury's period hits the 0.35-s clamp (aliasing), so document the clamp. The phase is per body on the CPU, so there are no per-frame allocations. Check that the ghost pass B still matches.

**Files.** `js/render/beams.js`, `js/render/shaders/beam.glsl.js`, `js/app/loop.js`

**Verifier evidence.** The current state is accurate. All beams share PULSE_HZ 0.6 (beams.js:42, 300-310), with ph = log(1+d)·0.9 + uPhase (beam.glsl.js:166). Pulses only run when the clock is faster than real time (loop.js:325), and lightTimeS is ignored by beams (snapshot.js:252).

**Verifier corrections.** Not worth it as proposed. (1) The headline moment, light crawling up the Moon beam in 1.3 s at rate 1, cannot be seen at the default ~3.4 ER camera distance. Only a few ER of the 60-ER beam are on screen, so the packet crosses them in ~0.1 s. (2) Pulses at Live 1× break render-on-demand: clock.isAnimating() is false at Live 1× (clock.js:144-145, 533), so the loop would have to redraw continuously while the Moon is selected. (3) With period = clamp(lightTime/|rate|, 0.35, 8 s), every body sits on a clamp at most rates: all hit 8 s at 1 min/s and 0.35 s at 1 day/s. Only a narrow band around 10 min/s to 1 h/s distinguishes them. Showing light time as text, or as a one-off 'light left at HH:MM' marker on the selected beam, communicates it better.

## Lens: Camera, motion & storytelling

The camera layer is carefully built: tweens run in Earth-fixed coordinates, a tested descent hides the globe's rim, and rendering is on demand. But it only knows three shots: an orbit that always looks at Earth's centre, a sky look fixed to the ground, and a fixed 4.5 s intro. So the app never frames a horizon, a body or an event the way a film would. I measured three camera defects: a shared sky-view link sends the globe camera to a random spot (South America for Paris), an eclipse jump from sky view flies away and back through that wrong waypoint, and "Center" leaves the body exactly behind the camera. The biggest opportunity is small: a follow/tilt extension to js/camera/rig.js plus a tour runner in js/app. The renderer already draws a striking umbra with Nile city lights showing through (camera-umbra-low.png) and beams fanning over a low-orbit horizon (camera-umbra-chase.png), but no current camera path goes there. With that extension, an eclipse shadow chase, a star-locked "the Earth turns" time-lapse and lighten-stacked star trails all become possible with no new assets.

### `eclipse-shadow-chase`: Ride the Moon's shadow: eclipse chase with the path of totality drawn live ★

*feature · impact 5→5 · effort L→L · verdict **revise***

**Pitch.** One button on a solar-eclipse event drops the camera into low orbit behind the umbra. The camera follows the shadow across Earth in about 40 s while the path of totality is painted behind it, with city lights switching on inside the shadow, and pauses at greatest eclipse. Every app lists eclipses; this one lets you fly alongside one.

**Current state.** jumpToEvent (js/app/actions.js:553-585) pauses, sweeps the clock and, after animateMs+60 ms, calls a single flyToLatLon to the greatest-eclipse point at distance 2.6. There the umbra is a speck under the pin rings (eclipse-luxor.png). shadowPoint() (actions.js:181-197) already intersects the shadow axis with the globe. events.js:233-249 gives only peak lat/lon, with no track or contact times. The Earth shader already darkens by the Sun's visible fraction and lets city lights show through the umbra (shaders/earth.glsl.js:181-187, 229-232). At 1.35 R this looks spectacular (camera-umbra-low.png), but the rig never goes below 2.6 R for an event.

**Proposal.** (1) Pure astro: add umbraTrack(peakMs,{stepS:60}) in js/astro/shadow.js. It samples the shadow-axis/Earth intersection (the shadowPoint maths on AE.GeoMoon, the Sun vector and the Earth rotation), bisects the start and end where the axis leaves the disc, and returns {startMs, endMs, latDeg[], lonDeg[], umbraKm[]}. The umbra radius comes from the cone, R_m*(1 - x/L) with L = d_ms*R_m/(R_s - R_m); a negative value means annular. Expose it as worker op 'umbraTrack' (about 200 samples, under 50 ms). (2) Render: a new js/render/eclipse-path.js module in an Earth-fixed group (reusing createLineLayer from render/sky.js, like trails.js). It draws the centreline plus the north and south limits, offset perpendicular to the track by the umbra radius. A uRevealMs uniform discards vertices later than the current time, so the ribbon grows with no per-frame allocation. (3) Rig: a new cancellable tween kind 'follow' with rig.follow(targetFn, {altitude: 0.12, backDeg: 6, tiltDeg}). Each frame, targetFn(snap, outL) writes the Earth-local shadow point. A critically damped spring (omega about 3/s) moves the camera to a point backDeg behind it along the track's velocity. The camera looks at the surface point, which is the tilted framing from idea tilt-on-zoom-horizon. On pointer input, syncControls() hands back to OrbitControls. (4) Choreography in actions/tours: clock.setRange({fromMs: start-10min, toMs: end, durationS: 40, loop: 'once'}), a 1.5 s hold at peak, then an optional 'Stand under it' cut to sky view at greatest-eclipse coordinates. Add a 'Watch from orbit' button to eclipse rows in js/ui/events-panel.js. Tiers: identical on all tiers (camera path plus one line layer). Reduced motion: a static low-altitude frame with the whole track revealed. Text mode: no-op, since the list text already exists. Size: about 10 KB JS.

**Risks.** Astronomy Engine has no path-of-totality API. A geometric track from AE positions is good to a few km, but the edge limits are a circle approximation (no lunar-limb profile), so label them 'approximate limits' in docs/ASTRONOMY.md. At 270x the frame snapshot is recomputed every frame (loop.js:253, SNAP_STALE_MS 500), which is fine. Low-tier textures (day2k) look soft at 0.12 R altitude, so use a higher chase altitude on low. Size budget: the low tier has about 90 KB of headroom (check-size: 3.71/3.80 MB) and the crawler counts dynamic imports (scripts/lib/modgraph.mjs:106), so all ideas here compete for it.

**Files.** `js/astro/shadow.js`, `js/astro/worker.js`, `js/astro/client.js`, `js/app/actions.js`, `js/camera/rig.js`, `js/render/eclipse-path.js`, `js/main.js`, `js/ui/events-panel.js`

**Verifier evidence.** The current state is accurate. jumpToEvent (actions.js:553-585) makes one flyToLatLon at distance 2.6 after animateMs+60. shadowPoint (actions.js:181-197) exists. events.js:243-245 gives only the peak geo. The Earth shader dims by discVisible (earth.glsl.js:183-186), and city lights show in the umbra (line 231). grep finds no totality track or umbraTrack anywhere. clock.setRange supports loop:'once' (clock.js:142, 446-469). The proposal is wrong to reuse createLineLayer: that layer is 'an anti-aliased line layer at infinity' (sky.js:105). LINE_VERT normalizes iA/iB and projects with mat3(viewMatrix) (sky.glsl.js:342-344), so it cannot draw a surface track with parallax. trails.js uses it only because trails are sky paths. In camera-umbra-low.png at 1.35 R, day4k texels (9.8 km) are already blocky. The oblique view in camera-umbra-chase.png looks far better. check-size: low tier 3.71/3.80 MB.

**Verifier corrections.** (1) Draw the path as a ribbon mesh on a sphere of radius about 1.002, with a per-vertex tMs attribute and its own small ShaderMaterial (discard when tMs > uNow, ending with the tonemapping and colorspace includes), in an Earth-fixed group whose matrix is set from earthMatrix in apply(). Another option is to bake the band once into a small equirect mask that the Earth shader samples. Do not use createLineLayer. (2) For the limits, intersect the umbral cone's two edge rays (in the plane perpendicular to the track) with the unit sphere at each sample. A perpendicular offset by the cone radius ignores the foreshortening at low Sun, where the real path widens greatly near its ends. A spherical Earth is right here because the shader is spherical too. (3) The chase altitude of 0.12 R is too low for day4k/day2k. Fly at about 0.3-0.5 R and look obliquely toward the horizon (the camera-umbra-chase framing), which hides texture softness. (4) syncControls() resets controls.target to the origin (rig.js:271), so handing an off-centre 'follow' pose back to OrbitControls snaps. Blend the orientation over about 400 ms. (5) setRange has no hold. Run two ranges (start to peak, hold, peak to end) or ease p.

### `sidereal-tracking`: Star-lock and body tracking in sky view ("the Earth turns, not the sky") ★

*feature · impact 5→4 · effort M→M · verdict **keep***

**Pitch.** A 'Track' toggle in sky view keeps the selected planet or Moon centred as time runs. A 'Lock to stars' mode instead holds the starfield perfectly still with celestial north up, so the horizon and landscape tilt and swing around it. This is the viral stabilized 'Earth rotation' time-lapse, made live for any place and date.

**Current state.** applySkyCamera (js/camera/rig.js:331-343) always orients with basisQuat(look, upW), so zenith is up and az/alt are ground-fixed. stepSky (rig.js:629-655) only eases toward ground-fixed targets. Searching js/camera, js/app and js/ui for 'track', 'follow', 'sidereal' or 'autoRotate' finds no tracking feature. In fast time the selected body drifts out of frame and the user has to chase it by dragging.

**Proposal.** Add rig state track = {kind: 'none'|'body'|'stars', dirW: Vector3 scratch, index}. In advance() in sky mode: for 'body', copy snap.bodies[i].dirS into dirW each frame. For 'stars', dirW is captured once, because the sky is static in the scene frame (CLAUDE.md, Scene frame). The desired orientation is basisQuat(dirW, up), with up = upW for 'body', or for 'stars' the J2000 pole (0,1,0) projected perpendicular to dirW, falling back to upW within 2 degrees of the pole. Slerp camera.quaternion toward it with a 600 ms ease when the mode is engaged, then follow exactly. Write sky.az/alt back from dirW (dot with northW/eastW/upW) so getView(), labels and the URL stay valid, and add a 'trk=b|s' hash key in core/url-state.js. A drag while tracking rotates dirW about upW and the camera right axis instead of cancelling. Expose actions.setTracking(kind) with a 'K' shortcut and a 'Track' chip on the body card. Fast time already renders continuously (loop.js:311, clock.isAnimating()). Low tier: identical (camera only). Reduced motion: allowed because it is user-initiated, but with no ease-in. Text mode: hidden. About 3-4 KB.

**Risks.** With star-lock the look can sink below SKY_ALT_MIN (-10 degrees, rig.js:44) as the field sets, so either allow the ground to fill the view or auto-release when the locked point drops below -8 degrees, with a toast. A rolled horizon breaks the assumption that sky-view cardinal labels sit just above the horizon (labels-feed.js); check the declutter at large roll angles. Twinkle (sky.js:516) is fine.

**Files.** `js/camera/rig.js`, `js/app/actions.js`, `js/core/url-state.js`, `js/ui/body-card.js`, `js/ui/shortcuts.js`, `js/ui/view-switch.js`

**Verifier evidence.** grep for track, follow, sidereal and autoRotate in js/ finds no camera tracking. applySkyCamera (rig.js:331-343) always uses basisQuat(look, upW), and stepSky (629-655) eases only toward ground-fixed az/alt. The sky is static in the scene frame, so a captured world direction holds the stars still. loop.js:311 renders continuously when clock.isAnimating(). Plain 'K' is free: shortcuts.js:70 uses only Ctrl/Cmd+K, for the palette. ground.js draws a hemisphere at infinity relative to uUp (ground.js:112-113), so a rolled camera renders correctly.

**Verifier corrections.** Star-lock pays off only when the ground shows the rotation. The sky-view ground is a featureless hemisphere (near-black at night), so pair star-lock with a horizon silhouette or landscape idea, or lead with body tracking, which helps immediately: a body leaves a 70-degree field in about 4 s at 1 h/s. stepSky clamps altT to SKY_ALT_MIN, so tracking needs its own path that bypasses the clamp, and releases with a toast below about -8 degrees as proposed.

### `lighten-stacking-exposure`: Long-exposure 'lighten' stacking: star trails and a real analemma photo ★

*visual · impact 5→4 · effort M→M · verdict **revise***

**Pitch.** Press 'Expose' in sky view and run time at 10 min/s. Every frame is max-stacked, as astrophotographers do, so stars draw concentric arcs around the celestial pole, planets and the Moon draw their paths, and the landscape stays crisp. With a 'same time every day' stride, the stacked Sun discs form the figure-8 analemma.

**Current state.** js/render/postfx.js:1-13 has a single scene target, then UnrealBloom, then FinalPass. needsSwap is false everywhere and there is no accumulation or history buffer. The clock's range mode (js/core/clock.js:446, set from js/ui/timebar.js:357-371) interpolates continuously, with no fixed-stride stepping for the stroboscopic analemma. Twinkle (sky.js:516) would make a stack flicker.

**Proposal.** Add an AccumPass ShaderPass between RenderPass and Bloom on medium and high: acc_next = max(acc_prev * decay, scene). decay is 1 for a true exposure and 0.97-0.995 for comet tails. It ping-pongs two HalfFloat render targets at scene resolution, allocated on enable and disposed on disable (never per frame). In the pass's onBeforeRender, reset the stack when camera.matrixWorld or projection changed, rig.dragging or rig.tweening is set, the clock emits 'jump', layers change or the observer changes. While exposing, set twinkle to 0 and hide the selection reticle. Clock: add a stride option to setRange, tMs = from + floor(p*N)*strideMs, with STEP.day from clock.js. The 'Analemma' preset is then sky view at local noon, a one-year range with a day stride over 20 s, and decay 1. UI: an 'Expose' toggle and a 'Save image' button in sky view (shares the photo export path). The fragment ends with the tonemapping and colorspace includes; three makes them no-ops when the target is a render target, so the shader rule holds. Hidden on the low tier (no composer there). Text mode: hidden. About 4 KB JS.

**Risks.** Memory: two extra RGBA16F targets, about 2x12 MB at 1440x900 with DPR 1.5, so release them when the mode turns off and on context loss. A daylight stack saturates; max() keeps a flat sky, which is fine for the analemma, but for star trails gate accumulation off when sunAlt > -8 degrees. Accumulation only happens on rendered frames, which is correct since a paused clock adds nothing. The governor's DPR drop resizes the targets and must reset the stack.

**Files.** `js/render/postfx.js`, `js/render/context.js`, `js/render/sky.js`, `js/render/bodies.js`, `js/core/clock.js`, `js/app/loop.js`, `js/ui/timebar.js`, `js/ui/view-switch.js`

**Verifier evidence.** postfx.js matches the description: one scene target, Bloom, then FinalPass, with needsSwap false (lines 9-11, 86, 197, 204). There is no accumulation buffer. The composer exists only on medium and high (quality.js:22, 28, 34), and twinkle only on high (quality.js:37). clock.js has STEP.day (line 23) and setRange (446) without a stride. grep for toBlob, toDataURL and readPixels in js/ finds nothing, so the 'photo export path' it plans to share does not exist yet.

**Verifier corrections.** The reset trigger 'camera.matrixWorld changed' would reset every frame in exactly the mode this idea targets. In sky view, applySkyCamera rebuilds the camera from posW, northW and eastW of each snapshot (rig.js:331-336), so the world pose turns with the Earth whenever time runs. Earth-lock does the same in orbit view. Key the reset on the rig's local view instead: getView() az/alt/fov or lat/lon/dist, plus rig.tweening, rig.dragging, clock 'jump', and layer, observer or DPR changes. Memory is about 23 MB per RGBA16F target at 2160x1350 (1440x900 at DPR 1.5), not 12 MB. Hide the DOM labels while exposing. Build the PNG export, which must read the canvas in the same task as the render because preserveDrawingBuffer is false (context.js:84). For the analemma, pace the stride by rendered frames, so a frame-rate drop below about 18 fps does not skip days.

### `tilt-on-zoom-horizon`: Tilt-on-zoom: an ISS-style horizon camera instead of a flat map ★

*visual · impact 4→3 · effort M→M · verdict **revise** · tracked under `orbital-horizon-view`*

**Pitch.** As you zoom below about 2 Earth radii, the camera pitches up so the curved limb, the atmosphere and the beams fanning into space fill the top of the frame, as in Google Earth or the ISS window. The globe stops looking like a map when you get close.

**Current state.** The orbit camera always looks at Earth's centre: controls.target is (0,0,0) at rig.js:193, syncControls zeroes it again (rig.js:269-277), and orbitQuat looks at the origin (rig.js:319-322). Zooming to MIN_DIST 1.08 (rig.js:49) therefore gives a straight-down, flat view (camera-umbra-low.png). Moving controls.target to a surface point through __app.internals gives camera-umbra-chase.png instead: Paris's beams rising over the limb and the umbra on the Nile. OrbitControls re-runs lookAt on every update (vendor OrbitControls.js:392), so a tilt applied after update is safe.

**Proposal.** After controls.update() in stepOrbit (rig.js:675), and in placeOrbitLocal (rig.js:324-329) and stepFly so hand-overs never snap, rotate camera.quaternion about its own right axis by tilt(r) = w(r) * (asin(1/r) - 0.55*fovV/2), with w(r) = smoothstep(1.9, 1.12, r). This puts the horizon about a quarter of the way down from the top edge, pitched toward screen-up (north under the default north-up orbit). Tilt is a pure function of distance, so getView()/cam=o:lat,lon,d links reproduce exactly, and picking and labels are already consistent because update() calls camera.updateMatrixWorld (rig.js:692). Keep tilt at 0 during toSky/toOrbit phase 1, which overrides orientation anyway, and blend it in across the hand-over. Lower MIN_DIST to 1.04 on medium/high (about 250 km). Set max anisotropy on the day, night and cloud textures in render/textures.js for grazing angles. Low tier: MIN_DIST 1.2 and a gentler tilt because of the day2k texture. Text mode: n/a. Under 1 KB of code.

**Risks.** Grazing views show texture softness (9.8 km/px on day4k) and the cloud shell at 1.006, but anisotropy helps. The descent tests (test/render.transition.test.mjs) assume a centre-looking start, so extend them. Users may expect a pure top-down view, so offer it as a Settings toggle (default on).

**Files.** `js/camera/rig.js`, `js/render/textures.js`, `test/render.transition.test.mjs`

**Verifier evidence.** The cited lines are accurate. controls.target is (0,0,0) (rig.js:193), syncControls zeroes it (271), orbitQuat looks at the origin (319-322), MIN_DIST is 1.08 (49), and vendor OrbitControls calls lookAt(target) on every update (OrbitControls.js:392). But anisotropy is already set to min(8, max) on every texture (textures.js:123, 230), so that part already exists. The proposed formula breaks close-range use. With tilt = w(r)*(asin(1/r) - 0.55*22.5), r=1.3 gives 32.8 degrees and r=1.12 gives 50.8 degrees, both beyond the 22.5-degree vertical half-FOV. The point directly under the camera, where flyToLatLon and double-click land and where users zoom in to click-place the observer, therefore leaves the bottom of the screen. OrbitControls dollies toward the origin, so zooming makes the target slide away. camera-umbra-low.png at 1.35 R already shows blocky day4k texels, so lowering MIN_DIST to 1.04 would make this worse.

**Verifier corrections.** Pivot on a surface point instead of pitching about a centre-looking camera. As distance falls, blend controls.target from the origin to the surface point under the screen centre, which keeps the clicked or observer point centred while the limb rises into view (this is how camera-umbra-chase.png was made). Alternatively, make pitch a user gesture (right-drag or two-finger vertical drag, as in Mapbox and Google Earth) that defaults to 0, and use auto-tilt only for scripted shots (eclipse chase, tours). Keep MIN_DIST as it is and drop the anisotropy item. getView needs a pitch parameter (for example cam=o:lat,lon,d,pitch) for links to reproduce.

### `bug-skylink-return-pose`: Bug: shared sky-view links send 'Globe' to a random spot

*bug · impact 3→3 · effort S→S · verdict **keep***

**Pitch.** Every link shared from sky view carries cam=s:...; pressing Globe then flies to an arbitrary point (South America for a Paris link) instead of over the observer.

**Current state.** Repro: /#loc=48.85,2.35&n=Paris&tz=Europe/Paris&t=2026-11-03T20:00:00Z&p=0&intro=0&view=sky&cam=s:180,20,70, then setViewMode('orbit'). rig.getView() ends at lat -0.0, lon -72.7, dist 3.4, with Paris on the limb (camera-sky-to-globe.png). Cause: main.js:832 calls rig.setView(hash.cam) before any snapshot, which queues pendingView. advance() applies it (rig.js:715-721) before the !initialized branch that homes the camera (rig.js:722-728). applyViewNow's sky branch then runs rememberOrbitPose() (rig.js:362) on the never-placed default camera at world (0,0,3.4) (render/context.js:96). share() always includes the camera (actions.js:437-447), so every shared sky link is affected.

**Proposal.** In applyViewNow's sky branch: if (mode === 'orbit') { if (initialized) rememberOrbitPose(); else { homePosL(orbitReturnL); hasOrbitReturn = true; } }, and set initialized after that. Add a unit test with a fake rc and snapshot: setView('s:180,20,70') before the first update, then update(), setMode('orbit', {animate: false}), and expect the final view's lat/lon equal to the observer's within 0.1 degrees.

**Risks.** None; this only changes the fallback for a pose that was never set.

**Files.** `js/camera/rig.js`, `test/`

**Verifier evidence.** Reproduced on a real GPU with /#loc=48.85,2.35&n=Paris&...&view=sky&cam=s:180,20,70, then setViewMode('orbit'). getView() went from {sky,180,20,70} to {orbit, lat -0.0017, lon -72.75, dist 3.4} (shots/camverify-skylink-globe.png). Cause confirmed: main.js:832 calls rig.setView(hash.cam) while hasSnap is false, which queues pendingView. advance() applies it (rig.js:715-721) before the !initialized homing branch (722-728). applyViewNow's sky branch calls rememberOrbitPose() (362) on the never-placed camera at (0,0,3.4) (context.js:96), and initialized is set to true, so homing never runs. shareUrl always includes getView() (actions.js:437-447).

**Verifier corrections.** Simpler fix: in applyViewNow, use `if (mode === 'orbit' && initialized) rememberOrbitPose();`. hasOrbitReturn then stays false, and startToOrbit already falls back to homePosL at transition time (rig.js:521), which also follows a later observer change. Add the unit test as proposed.

### `bug-event-jump-double-flight`: Bug: event jumps from sky view fly away, then back, in two sequential moves

*bug · impact 3→2 · effort S→S · verdict **revise***

**Pitch.** Jumping to the 2027 eclipse from sky view should be one shot that lands over the shadow while the date spins. Today the camera climbs to an unrelated pose, then makes a second flight, about 3 s of travel through a pointless waypoint.

**Current state.** Repro, from the sky-view URL above: __app.actions.jumpToEvent({kind:'solar-eclipse', tMs: Date.parse('2027-08-02T10:07:50Z'), select:'sun', view:'orbit', geo:{latDeg:25.5, lonDeg:33.2}}). The sampled camera path goes sky, then orbit at (0.0, -72.7, 3.4) at +1.8 s (camera-jump-5600.png shows the Americas), then a second flight that ends at (25.5, 33.2, 2.6) at +2.9 s. Cause: setViewMode (actions.js:560) fires the store subscription, so rig.setMode('orbit') (main.js:935-941) starts toOrbit to orbitReturnL. The shadow flight is deferred until after the 1.4 s time sweep (actions.js:565, animateMs+60) and then queued behind the transition (rig.js:928-931).

**Proposal.** In jumpToEvent, compute the target synchronously: ev.geo is Earth-fixed, and the fallback shadowPoint(scratchSnap) costs one computeSnapshot. Call rig.flyToLatLon(lat, lon, {distance}) before setViewMode. In sky mode that starts the sky-to-orbit transition straight to targetL (rig.js:971; startToOrbit accepts targetL, rig.js:519-521). Because the rig's mode is already 'orbit', the store-driven setMode('orbit') returns the running tween's promise (rig.js:1040). Rig flights are Earth-fixed (rig.js:12-16), so the camera lands correctly while the clock sweeps at the same time. Do the same for sky events: compute the look from scratchSnap immediately and pass it to setMode('sky', {look}). The result is one 1.8 s shot overlapping the sweep.

**Risks.** With Earth-lock off, an Earth-fixed target is still right because flyToLatLon is always Earth-fixed. Keep the timer path for events with no geo when the sweep must finish first.

**Files.** `js/app/actions.js`, `js/camera/rig.js`

**Verifier evidence.** Reproduced without a cam= link (view=sky, Paris), by sampling getView every 200 ms after jumpToEvent(2027 eclipse). The camera rises over Paris to 3.4 R by about 1.85 s (the toOrbit transition to orbitReturnL), then makes a second flight that ends at (25.5, 33.2, 2.6) at about 2.67 s. That is two legs. The far-off waypoint in the original repro (lon -72.7) comes from bug-skylink-return-pose, not from this bug. For the orbit case the fix is sound: in sky mode flyToLatLonNow calls startToOrbit({targetL}) (rig.js:971), and the store-driven rig.setMode('orbit') then returns the running tween's promise (rig.js:1040).

**Verifier corrections.** The sky-event half would regress as written. The view.mode subscriber (main.js:935-941) passes look: lookFor(store, snap), using the loop's pre-sweep frame snapshot. Because opts.look is set, rig.setMode calls afterTransition(() => setModeNow('sky', {look})) (rig.js:1040-1041), which queues a startLook to the stale, pre-event position after the event's transition. Set the view with a distinct source (store.set(..., 'event')), have the subscriber skip its look for that source (subscribers receive the source), or skip the look when the rig is already transitioning to that mode. Once the skylink bug is fixed, the waypoint is over the observer and the cost is about 1 s of extra travel, so impact is 2.

### `guided-tours`: Guided tours: "Tonight from here", "A year in a minute", the 2027 eclipse, and an ambient mode ★

*feature · impact 5→4 · effort L→L · verdict **keep***

**Pitch.** One tap plays a narrated, skippable mini-documentary built from your own sky: sunset, then each visible planet at its best moment with a caption, then the Moon. Other tours cover the seasons sweeping across the globe in 60 s and the eclipse chase. A tour is shareable as #tour=tonight and also runs as a narrated timeline in text mode.

**Current state.** The only scripted sequence is the fixed 4.5 s intro (js/app/intro.js, runIntro in main.js:1179-1223), which already has abort-on-input wiring and UI hiding. almanac.tonight() already returns, per body, bestMs, bestAltDeg, bestAzDeg, verdict and a ready-made sentence (js/astro/almanac.js:403-419). Cinema mode exists (actions.toggleCinema, the is-cinema CSS). OrbitControls.autoRotate is vendored but unused (vendor OrbitControls.js:105). There is no caption or storytelling layer.

**Proposal.** Add js/app/tours.js, pure and without three (it may live in js/app). The format is an async step list: {at: {tMs|range}, clockAnimMs, view, look: {azDeg, altDeg, fovDeg} | fly: {latDeg, lonDeg, distance} | follow: fn, select, layers, caption, holdMs}. The runner sequences existing APIs (clock.setTime with animateMs, clock.setRange, actions.select/setViewMode/toggleLayer, and rig.setMode/flyToLatLon/flyToDir with their promises). It reuses runIntro's AbortController skip wiring, suspends bindUrl hash writes, and restores the user's state on exit. Captions go in a lower-third DOM element (fades, no layout thrash) and are mirrored to the announcer for screen readers. Presets: (1) Tonight, generated from the worker's tonight() result: for each report with verdict excellent, good or low, sorted by bestMs, jump to bestMs, look at its bestAz/bestAlt with the FOV narrowed to 40, select it, and caption with report.sentence. (2) A year in a minute: orbit view, Earth-lock off, a range stepped by day at local noon showing the terminator tilt and the subsolar point. (3) The 2027 eclipse, using eclipse-shadow-chase. (4) Ambient: slow autoRotate with cuts to the highest bright planet every 30 s, for a kiosk or TV. Text mode: camera steps no-op (actions already degrade, actions.js:1-6) and captions plus clock jumps still play. Reduced motion: the rig turns flights into cuts. About 14 KB.

**Risks.** Worker calls are async (50-100 ms) and must be awaited and cancelled cleanly. Tours must not persist observer or layers to prefs, so keep a snapshot and restore it. Captions need localization later. Watch the size budget headroom on the low tier.

**Files.** `js/app/tours.js`, `js/main.js`, `js/app/actions.js`, `js/core/url-state.js`, `js/ui/index.js`, `js/ui/sky-now.js`, `css/app.css`

**Verifier evidence.** Each building block the idea names exists. runIntro (main.js:1179-1223) has AbortController skip wiring and the introPlaying status. tonight() reports carry bestMs, bestAltDeg, bestAzDeg, verdict and sentence (almanac.js:403-419) and are exposed as a worker op (worker.js:48). toggleCinema exists (actions.js:527). clock.setRange supports once, loop and pingpong. OrbitControls.autoRotate is vendored and unused (OrbitControls.js:105, 304). grep finds no tour, caption or storytelling layer. setObserver persists only USER_SOURCES (actions.js:257-261), so a tour that uses a non-user source will not touch prefs.

**Verifier corrections.** bindUrl returns only a dispose function (url-state.js:460) and main.js discards it, so 'suspend hash writes' needs a new flag or API. A tour's quality depends on the sky view, whose ground is empty at night, and on body tracking (sidereal-tracking) and the eclipse chase. Sequence it after those, or the 'Tonight' tour is a string of static look-ats. Impact is 4 rather than 5, because it packages existing moments rather than creating new visuals.

### `earthrise-vantage`: Vantage points: Earthrise from the Moon, and the DSCOVR view from L1 ★

*feature · impact 5→4 · effort L→L · verdict **revise***

**Pitch.** 'View from the Moon' puts the camera just over the lunar limb with the real Earth, in its true phase and lighting, hanging above the grey horizon: Apollo 8's Earthrise for any date. 'View from L1' shows the fully lit disc in which, on eclipse day, the Moon's shadow crosses the face like NASA's EPIC frames.

**Current state.** The Moon is already a true-scale, IAU-oriented sphere with Lommel-Seeliger lighting and earthshine at moonPosS (js/render/bodies.js:1-12, 233). The rig only orbits the origin, with MAX_DIST 150 (rig.js:50) and the orbit FOV fixed at 45 (rig.js:40). The camera far plane is 4000 (render/context.js:95). There is no way to stand anywhere but Earth's surface or orbit.

**Proposal.** Add a rig tween kind and mode 'vantage' whose pose is recomputed each frame from the snapshot, so time-lapse makes the Earth rise and set. Moon: position = moonPos + R_m*1.02*(normalize(moonPos)*cos(beta) + perp*sin(beta)), with beta about 88 degrees so the lunar limb grazes the bottom of the frame. It looks at Earth's centre with ecliptic north up and FOV 5 degrees (Earth spans 1.9 degrees from the Moon). L1: position = sunDirS*235 (MAX_DIST raised for this mode only) with FOV 0.7 degrees. Depth: at 60 R with near 0.002, 24-bit depth gives a resolution of about 0.1 R, far worse than the 0.006 R cloud-shell gap (earth.js:18). So in vantage mode, render in two depth ranges: the main RenderPass with camera.near 40, then a second RenderPass(scene, moonCam) with clear=false, clearDepth=true, moonCam.near 0.001, far 40 and layers set to a MOON layer. Enable it only in this mode. Entry and exit transitions reuse stepFly's log-distance interpolation. All tiers (moon_1024 is soft at the limb, but the silhouette dominates). Text mode: hidden. About 6 KB.

**Risks.** The two-pass depth change touches the composer path and the no-composer low-tier path (context.render), so both need care. Labels and beams assume an Earth-centred camera; hide the beams in vantage mode. moon_1024 detail is limited, and a 2k texture would cost about 600 KB, which breaks the tier budgets. Picking is disabled in this mode.

**Files.** `js/camera/rig.js`, `js/render/postfx.js`, `js/render/context.js`, `js/render/bodies.js`, `js/app/actions.js`, `js/ui/view-switch.js`

**Verifier evidence.** The Moon is a true-scale SphereGeometry(MOON_RADIUS_ER, 64, 32) with Lommel-Seeliger lighting (bodies.js:1-12, 233). MAX_DIST is 150 (rig.js:50), ORBIT_FOV is 45 (rig.js:40), and the far plane is 4000 (context.js:95). There is no vantage mode. moon_1024.jpg (textures.js:28) is about 10.7 km per texel. From 35 km above the limb (beta 88, 1.02 R_m) the horizon is about 350 km away, so a 5-degree frame spans about 30 km of foreground, roughly 3 texels: a featureless grey smear, and the 64-segment sphere's limb is a straight facet edge. setNearFor clamps near to 0.05 or less (rig.js:254-260). At L1 (r=235) that gives about 0.066 R depth resolution, an order of magnitude coarser than the 0.006 R cloud-shell gap.

**Verifier corrections.** Split this into two parts. (a) Build the L1/EPIC view first. It is camera-only: raise MAX_DIST for that mode, use FOV about 0.7 degrees, and make setNearFor scale near with distance (for example near = 0.8*(r-1)). That alone fixes the depth problem without the two-pass trick. The eclipse-day shadow crossing the disc already renders through the Earth shader. Impact 4, effort S-M. (b) For Earthrise, use a lunar-orbit vantage (Kaguya-style, about 100-300 km up, FOV 15-25 degrees) or a procedural limb silhouette instead of a 5-degree telephoto over a 1k texture. Keep the two-range depth split for that mode only. Hide beams and labels and disable picking as proposed.

### `bug-center-behind-camera`: Bug: 'Center' and double-click-to-fly put the body behind the camera

*bug · impact 3→3 · effort S→S · verdict **revise***

**Pitch.** The body card's 'Center' button says 'Turn the view toward it', but in globe view the planet ends up exactly behind the camera, along with its reticle. You get a view of the hemisphere under Mars, never Mars itself.

**Current state.** Repro: HCMC, t=2026-11-03T14:00Z, actions.select('mars', {fly: true}). After the flight, normalize(camera.position) dotted with Mars dirS is 1.000 and Mars projects to NDC z = 1.1, which is behind the camera (camera-flytomars.png: the Americas, Mars off-screen). Cause: flyToBody calls rig.flyToDir(b.dirS) (actions.js:371), which places the camera on the body's direction (rig.js:956-959). The tooltip is in js/ui/body-card.js:75.

**Proposal.** Use an over-the-shoulder framing for 'Center'. Fly to the distance d = 4.2 and the direction dir rotated by alpha = asin(1/d) + 0.45*(fovV/2) about axis normalize(dir x upS). The body then sits just past the limb at about 70% of the half-height, with the observer's beam rising off the globe toward it; if the body is below the horizon, the x-ray beam crosses the globe instead. All of this works inside the existing centre-targeted orbit, so no OrbitControls change is needed. Keep the old pose as a separate action, 'View from <body>' ('where on Earth it is overhead'), which is meaningful but differently named.

**Risks.** For the Sun this framing puts the Sun's glare just outside the limb, which looks good and is where the flare is designed to work. Insets (the side panel) shift the frame centre, so compute alpha from the free-area height.

**Files.** `js/app/actions.js`, `js/camera/rig.js`, `js/ui/body-card.js`

**Verifier evidence.** Measured in-app (HCMC, 2026-11-03T14:00Z, Mars). After actions.flyToBody('mars'), the angle between camera forward and Mars's dirS is exactly 180.0 degrees, so Mars is directly behind the camera. Cause: flyToDirNow puts the camera along dirS looking at the centre (rig.js:956-959). This is deliberate ('look at the Earth from direction dirS', rig.js:1051; 'look along its beam', actions.js:357), but the button says 'Center' with the tooltip 'Turn the view toward it' (body-card.js:75), so it is a UX mismatch rather than a crash. The proposed formula does not fix it. Rotating dir by alpha = asin(1/4.2) + 0.45*22.5 degrees and flying there still leaves Mars 156.1 degrees from forward, behind the camera. The geometry is reversed, and alpha (23.9 degrees) is larger than the 22.5-degree vertical half-FOV in any case.

**Verifier corrections.** Put the camera on the anti-body side at -R(axis, beta)*dir, with distance 4.2 and beta = atan(0.7*tan(fovV/2)) (about 16.2 degrees, just past the 13.8-degree limb). Measured: Mars sits 16.2 degrees from forward at NDC y = 0.84, just past the limb, with its beam crossing the globe (shots/camverify-center-anti.png). Compute fovV/2 from the free area (insets). Keep the current pose as a separately named 'View from <body>' action.

### `intro-preroll-matchcut`: Intro: let the opening breathe, and match-cut from the loader's globe

*ux-polish · impact 3→2 · effort S→S · verdict **revise***

**Pitch.** The intro's most dramatic beat, the far night-side approach, currently plays under the fading loader. Holding the opening pose until the fade ends and starting from the exact size and position of the loader's globe icon makes the icon turn into the real planet.

**Current state.** setPhase('ready') starts the loader's 0.7 s opacity fade (main.js:852 to loader.done; index.html:60-61), and runIntro starts on the same tick (main.js:855-856). The dolly is front-loaded with easeOutQuart (intro.js:162), so 54% of the log-distance (9 R to 5.3 R) passes under the fade (camera-intro-1500.png shows the loader title over a globe already at about 5 R). The hidden side panel's inset still shifts the globe about 190 px left during the UI-less intro (camera-intro-2000.png). The horizon disc is visible from the first frame although pin.prime() hides the pin (pin.js:21, 240-264). rig.setViewInsets snaps the view offset in one frame (rig.js:750-761).

**Proposal.** (a) In runIntro, await the loader's transitionend (capped at 800 ms) while holding placeCamera(0), then start t0. (b) Match cut: the loader globe is r = 24 CSS px at the .pc-ld__art centre (index.html:201-231). Choose startDist = 1/sin(atan(24/(H/2)*tan(22.5 deg))), about 45 R at 900 px, and use setViewOffset so the Earth sits at that screen point. Then log-dolly from 45 R to 3.4 R with easeInOutCubic instead of easeOutQuart. (c) Zero the insets while is-intro is set, and add a 600 ms eased view-offset transition in applyInsets (this also fixes the jump when the side panel collapses). (d) Scale the horizon disc from 0 to 1 with the pin drop's ripple.

**Risks.** The intro maxMs safety net (8 s, and 9 s in main.js:1205) must include the pre-roll. Smoke --at timings shift by about 0.7 s.

**Files.** `js/app/intro.js`, `js/main.js`, `js/camera/rig.js`, `js/render/pin.js`, `index.html`

**Verifier evidence.** Confirmed. setPhase('ready') calls loader.done() (main.js:643-647). The loader fades over 0.7 s (index.html:60-61). runIntro starts on the same tick (main.js:854-856). The dolly uses easeOutQuart (intro.js:162). At u=0.175 that is 54% of the log distance (9 R to 5.3 R), and camera-intro-1500.png shows the loader text over an already-large globe. bindViewInsets still measures the hidden panel during is-intro (main.js:1027-1029; is-intro only sets opacity 0, index.html:52), so the globe sits about 190 px left in camera-intro-1500.png. applyInsets snaps setViewOffset in one call (rig.js:750-761). The loader globe is r=24 at the .pc-ld__art centre (index.html:228).

**Verifier corrections.** Keep (a) the pre-roll, (c) zero insets during the intro plus an eased view-offset transition (which also fixes the jump when the side panel collapses), and (d). Downgrade (b). The intro starts on the anti-sun side (introStartDir, -0.7*sun + 0.7*up, intro.js:91-101), so the real Earth first appears as a dark crescent, while the loader icon is a bright, fully lit gradient disc. A size and position match reads as a dissolve, not a match cut, unless the start pose is also changed to a sunlit gibbous view. Add the pre-roll to the 8 s and 9 s safety nets.

### `timelapse-video-export`: Record a time-lapse: deterministic 1080p or vertical video with labels and a date stamp burned in

*feature · impact 4→3 · effort L→L · verdict **revise***

**Pitch.** 'Record' in the time-lapse popover renders the chosen range frame by frame into a smooth 60 fps MP4 or WebM, with labels, place, date and captions burned in, ready for social media. An eclipse chase or a star-trail night becomes something people can share.

**Current state.** The time-lapse range UI exists (js/ui/timebar.js:337-376, then clock.setRange). The canvas uses preserveDrawingBuffer:false (render/context.js:84). Labels are pooled DOM elements (render/labels.js:1-13), so any plain canvas capture loses them. There is no MediaRecorder, captureStream or toBlob anywhere in js/ (grep). The rig and intro already accept injected now/raf (rig.js:176, intro.js:113-114).

**Proposal.** Add js/app/recorder.js, imported on demand. Stop the loop and add loop.renderOnce(nowVirtual), a synchronous variant of frame() (loop.js:236-391) driven by a virtual timebase; build the rig with now: () => timebase.now(). For each frame n, call clock.setTime(from + n*dt) and renderOnce. In the same task, drawImage the WebGL canvas into an OffscreenCanvas 2D, then draw labels through a new labels.forEachVisible((x, y, text, colorVar, kind) => ...) that reads the pool's last transforms, plus a lower-third with place, date and caption. Encode with WebCodecs VideoEncoder (avc1.640028 or vp09), with backpressure on encodeQueueSize, and mux with mp4-muxer 5.x (MIT, about 40 KB, pinned in vendor/VENDOR.json and fetched by npm run vendor). The fallback with no dependencies is canvas.captureStream(0) plus track.requestFrame() into MediaRecorder WebM, paced in real time. Presets: 1920x1080 and 1080x1920 (via setViewOffset), 30 or 60 fps. Low tier: 720p max. Text mode: hidden. Shares the PNG still-export path for a photo button.

**Risks.** The size crawler follows dynamic imports (scripts/lib/modgraph.mjs:106), so a 40 KB muxer would count against every tier's boot budget. Add an on-demand budget class to check-size.mjs, or ship MediaRecorder-only first. WebCodecs is unavailable in older Safari and Firefox, so feature-detect. A 4K render on a weak GPU is slow but deterministic; show progress and allow cancel.

**Files.** `js/app/recorder.js`, `js/app/loop.js`, `js/render/labels.js`, `js/main.js`, `js/ui/timebar.js`, `vendor/VENDOR.json`, `scripts/check-size.mjs`

**Verifier evidence.** grep for MediaRecorder, captureStream, VideoEncoder, toBlob, toDataURL and readPixels in js/ finds nothing, so there is no 'PNG still-export path' to share. preserveDrawingBuffer is false (context.js:84). Labels are pooled DOM elements, and labels.js exposes no iteration over visible labels. The size crawler follows dynamic imports (modgraph.mjs:106, line 107 'refs.dynamic'). check-size: low 3.71/3.80 MB, medium 4.19/4.30, high 5.24/5.40, so a 40 KB muxer would count against every tier.

**Verifier corrections.** Ship MediaRecorder first. Chrome (126+) and Safari can record MP4/H.264 directly from canvas.captureStream(), and WebM elsewhere, with no vendored muxer. Use captureStream(0) plus track.requestFrame() after each synchronous render. WebCodecs plus mp4-muxer can come later behind an on-demand budget class in check-size.mjs, only if exact timestamps and offline rendering faster or slower than real time are needed. The burned-in labels need a new labels API that returns the last transforms and texts, and a 2D canvas renderer that matches the CSS. Build the PNG still export first as the shared base.

### `sky-zoom-to-cursor`: Sky view: zoom toward the cursor or pinch centre, double-click to centre

*ux-polish · impact 3→2 · effort S→S · verdict **keep***

**Pitch.** Wheel and pinch zoom in on whatever is under your finger, as in Stellarium or Google Maps, instead of the screen centre, and a double-click on empty sky glides to it. It makes the sky feel like a physical object.

**Current state.** onWheel scales sky.fovT about the screen centre (rig.js:874-884), and so does pinch (rig.js:831-835). A double-click in sky view on anything but a body glyph does nothing (main.js:1082 returns when not in orbit).

**Proposal.** Before changing fovT, unproject the cursor NDC to a world direction d0 using camera.projectionMatrixInverse, which already includes setViewOffset. After the change, compute where d0 would project with the new FOV and rotate the look (azT, altT) by the angular difference between the ray at the old and new FOV at that NDC. Two fixed-point iterations are enough, since the az/alt mapping is smooth away from the zenith. Use the pinch midpoint for pinch. For a double-click on empty sky, call startLook(az, alt of d0, {fovDeg: fov*0.6}). Scratch vectors only. Same on all tiers.

**Risks.** Near the zenith (altT clamped at 89, rig.js:45) the correction saturates, so clamp it gracefully. Make sure keyboard +/- keep zooming about the centre.

**Files.** `js/camera/rig.js`, `js/main.js`

**Verifier evidence.** onWheel scales sky.fovT about the screen centre (rig.js:874-884). Pinch also scales fov about the centre (rig.js:831-835). handleSceneClick returns early in sky view when no body is picked (main.js:1081). There is no anchor logic. getView and setViewOffset already exist, so unprojecting the cursor is straightforward.

**Verifier corrections.** stepSky eases az/alt/fov toward their targets with the same exponential (rig.js:641-647). The anchor stays roughly but not exactly under the cursor while easing. Either recompute the az/alt target each frame from the anchored direction while the fov eases, or accept the small drift. This is minor polish: impact 2.

### `fast-time-star-streaks`: Velocity streaks to stop star strobing in fast time

*visual · impact 3→2 · effort M→M · verdict **revise***

**Pitch.** At 1 day/s with Earth-lock on, the starfield jumps 6 degrees per frame, and 42 degrees at 1 week/s, a strobing wagon-wheel effect. Motion-stretched stars turn that into smooth sweeping arcs, so fast time reads as motion.

**Current state.** Earth-lock is on by default and carries the camera with the Earth (rig.js:739-741), so the static sky spins past at 360 degrees per sidereal day of simulated time. Stars are THREE.Points with a Gaussian PSF (render/sky.js:294, shaders/sky.glsl.js:59-115), with no motion blur. Planet glyphs and the Milky Way strobe the same way.

**Proposal.** Store the previous frame's view-projection in a preallocated Matrix4 in sky.update(fi) and pass it as uPrevViewProj. In the star vertex shader, project both positions and take the screen displacement delta. Set gl_PointSize = 2*radius + min(|delta|, 48 px), and in the fragment shader evaluate the PSF against the distance to the segment (a capsule), scaling intensity by 1/(1 + |delta|/sigma) to conserve energy. Above 48 px per frame, fade the stars toward a dim ring blur. Apply the same to the Milky Way with a textureLod bias proportional to angular speed, and to the glyph quads in bodies.js. Low tier: no streaks, just dim stars by angular speed. Reset uPrevViewProj on cuts (tween start, setView).

**Risks.** Max point size (1024 on ANGLE D3D11, lower on some mobiles) caps streak length, so query ALIASED_POINT_SIZE_RANGE. With render on demand, the first frame after idle has a stale previous matrix, so reset it when dtMs > 100.

**Files.** `js/render/sky.js`, `js/render/shaders/sky.glsl.js`, `js/render/bodies.js`, `js/render/shaders/bodies.glsl.js`

**Verifier evidence.** Stars are THREE.Points with a Gaussian PSF (sky.js:288-299, sky.glsl.js:59-120) and have no motion term. Earth-lock rotates the camera with the Earth (rig.js:739-741). The rate ladder reaches 1 day/s, 1 week/s and 1 year/s (clock.js:20-21). At 1 day/s the sky turns about 6 degrees per frame, roughly 120 px at a 45-degree FOV over 900 px, which is already beyond the proposed 48 px cap. Streaks therefore help only between about 1 and 6 h/s. Faster rates fall to the 'fade' fallback.

**Verifier corrections.** Start with the cheap part: one uniform that dims stars, constellation lines and the Milky Way by angular speed (rate times Earth-lock state), which handles the worst aliasing at 1 day/s and above, on every tier (size S). Add streaks only for the 1-48 px/frame window and only for brighter stars, preferably as oriented instanced quads (like LINE_VERT) rather than enlarged square point sprites, whose overdraw grows with the square of the streak length (about 9k stars on high). Only the view rotation matters for stars at infinity, so a mat3 of the previous view is enough. With Earth-lock off, the Earth texture strobes instead, and streaks do not address that.

### `orrery-zoom-out`: Powers of ten: zoom out until the beams become lines across the solar system ★

*feature · impact 5→4 · effort XL→XL · verdict **revise***

**Pitch.** Keep scrolling out past the Moon and the globe shrinks to a dot in a live orrery. Each beam continues as the true line from Earth to its planet across the solar system, which shows why Mars is in Leo tonight.

**Current state.** Orbit zoom stops at MAX_DIST 150 R (rig.js:50), with the far plane at 4000 (render/context.js:95). Planets exist only as glyphs at infinity (render/bodies.js:4-7), and nothing heliocentric is computed or drawn.

**Proposal.** Add the Sun-centred position of each planet (AE.HelioVector, 8 vectors, scene frame) to the 'frame' snapshot detail; that stays pure. Add a js/render/orrery.js module with its own Scene and Camera, rendered first. Positions use log-compressed heliocentric distance r' = k*ln(1 + r/0.2 AU). Orbits are 256-point polylines sampled once per body in the worker over one period and cached. Earth-to-planet lines are coloured like the beams; planets are sprites; the Sun uses the bodies.js disc shader. A new rig mode 'system' orbits the Sun with its own OrbitControls instance. For the scale transition between 80 and 150 R, crossfade the globe scene into the orrery with the Earth dot screen-matched, and fade beam opacity into the Earth-to-planet lines. Time-lapse then shows retrograde loops forming as Earth overtakes Mars. Low tier: lines and sprites only. Text mode: n/a. About 15 KB.

**Risks.** The log scale must be clearly labelled 'distances compressed' (docs/ASTRONOMY.md accuracy budget). A two-scene render adds a pass on the low tier. Adding heliocentric vectors to the frame snapshot adds 8 AE.HelioVector calls per snapshot, which is cheap but must not allocate (reuse Float64Array(3)). Size headroom on the low tier is tight.

**Files.** `js/render/orrery.js`, `js/astro/snapshot.js`, `js/astro/worker.js`, `js/camera/rig.js`, `js/main.js`, `js/render/context.js`, `js/render/beams.js`

**Verifier evidence.** MAX_DIST is 150 (rig.js:50) and the far plane is 4000 (context.js:95). Planets are glyphs at infinity (bodies.js:4-7). grep for HelioVector, helio and orrery in js/ finds nothing. Nothing heliocentric is computed.

**Verifier corrections.** Log-compressing the heliocentric distance, r' = k*ln(1 + r/0.2 AU), bends the Earth-to-planet lines. In compressed space the Earth-to-Mars line no longer points along Mars's true geocentric direction, so the beams on the globe and the orrery lines would visibly disagree during the crossfade, which defeats the stated point ('the true line ... why Mars is in Leo'). Either use a linear heliocentric scale out to Saturn, with exaggerated body sizes and the outer planets as edge arrows, or compress geocentric distance along each true geocentric direction (planet' = Earth + dir_geo*f(d)), which keeps beam directions exact at the cost of distorted orbits. A separate Scene/Camera for the orrery is the right fix for the depth range. Size headroom (about 90 KB on low) is shared with every other idea here. Impact is 4: spectacular, but far from the app's core of where to look from here.

## Lens: Interface, design & mobile

The DOM interface is well engineered and consistent. It has a no-framework h() toolkit, WAI-ARIA tabs, combobox and slider, focus traps, narrated announcements, container queries, a three-snap bottom sheet and a real text mode, all in a coherent dark-glass design with tabular numerals and body-colour tokens. The weakness is that almost everything is tabular. The Sky panel, the body card and the events list are lists of numbers and generic glyphs, and the scrubber shows only a muted navy Sun gradient. Sharing is link-only, and the phone layout is a shrunken desktop: keyboard tips on touch, no gesture help, no touch way to hide the UI, and a date truncated by 1 px. The biggest opportunity is to turn the app's best moments into designed, shareable artefacts, with phone-native pointing at the sky as the mobile signature. The first is an Eclipse Companion for the 2 Aug 2027 totality, which is 9 months from today and already in the event list. The second is a one-tap 'sky postcard' image share. Hard constraint: the low tier has only about 90 KB of raw headroom (3.71 of 3.80 MB), and scripts/lib/modgraph.mjs:106 counts dynamic imports. New UI code must stay lean, or the budget has to be consciously re-baselined.

### `eclipse-companion`: Eclipse Companion: a countdown and contact-timeline HUD for local eclipses (ready for 2 Aug 2027) ★

*feature · impact 5→4 · effort M→M · verdict **keep***

**Pitch.** When the clock nears a local eclipse, a glass HUD shows 'Totality in 00:27:14', a C1-C2-Max-C3-C4 contact track with a live playhead, a large Sun disc being eaten by the Moon, and one button: 'Play the eclipse'. The total eclipse over Luxor and Egypt on 2 Aug 2027 (6+ min of totality) is 9 months away. The app already knows about it but only shows a static pill, so this turns the most-shared astronomy event of the decade into the app's signature moment, even on the low tier and in text mode.

**Current state.** The Sky header shows only the static pill 'Total solar eclipse · Sun 81.7°' (js/ui/sky-now.js:170-176, solarEclipseState at :260-273). The body card shows a static sentence (js/ui/body-card.js:210-214) and a 64-px disc with a Moon bite (drawPhaseDisc cover, body-card.js:360-364). js/astro/events.js:262-273 calls AE.SearchLocalSolarEclipse but pushes only ls.peak.time, so partial_begin, total_begin, total_end and partial_end (astronomy.js:8562-8569) are thrown away. The scrubber draws a single diamond tick (js/ui/timebar.js:683-689). Screenshots: ui-eclipse-partial-details.png (68% covered, no countdown) and eclipse-sky.png.

**Proposal.** (1) Pure: in events.js add c1Ms, c2Ms, maxMs, c3Ms, c4Ms, totalDurS and the Sun's altitude at each contact to the 'local-solar-eclipse' event. For lunar eclipses, derive contacts from SearchLunarEclipse sd_penum, sd_partial and sd_total. (2) New js/ui/eclipse-hud.js, mounted in the overlay. It activates when ui.events has a local eclipse with t in [c1−3 h, c4+30 min], or right after jumpToEvent lands on one. It is a top-centre glass card with a tabular countdown to the next contact, a 5-node contact track (a mini canvas reusing the timebar's playhead style), and a 140-px disc drawn with drawPhaseDisc(cover) plus a 2D-canvas corona and Baily's-beads glow when sep < rM−rS. It also carries the safety line from events.js:271. (3) 'Play the eclipse' calls clock.setRange({fromMs: c2−120 s, toMs: c3+120 s, durationS: 40, loop: 'once'}) (the same API as timebar.js:371). 'Jump to C2 − 2 min' calls clock.setTime. (4) The scrubber gets a gold band from C1 to C4 and a black notch for totality in drawTicks. (5) The Events hero card shows the contact table and a countdown ('in 272 d'). Size: about 7 KB raw. The low tier is identical, because the HUD is DOM plus 2D canvas. Text mode shows the HUD inline above Sky now.

**Risks.** About 7 KB of the ~90 KB low-tier headroom. AE contact times ignore observer elevation and lunar limb profile, so they are good to a few seconds. Label them 'approx.' and never present them as safety timing. The visual black disc and corona in the 3D sky view belong to the render lens. This HUD makes the moment legible even if that work lands later. Clean console: guard events that lack contacts, such as older cached lists.

**Files.** `js/astro/events.js`, `js/ui/eclipse-hud.js`, `js/ui/index.js`, `js/ui/timebar.js`, `js/ui/events-panel.js`, `js/ui/body-card.js`, `css/app.css`

**Verifier evidence.** js/astro/events.js:262-277 calls AE.SearchLocalSolarEclipse but pushes only tMs=peak, eclipseKind and obscuration. partial_begin, total_begin, total_end and partial_end exist on LocalSolarEclipseInfo (vendor astronomy.js:8562-8569) and are dropped. js/ui/sky-now.js:170-176 shows a static pill and body-card.js:210-214 a static sentence. drawPhaseDisc already draws the Moon bite (body-card.js:360-364, 64-px canvas). timebar.js:683-689 draws one 1.35x diamond for eclipses. clock.setRange supports loop:'once' (clock.js:446-465). I ran AE from 2026-11-03. Luxor gets a total eclipse: C1 08:40:09, C2 10:01:55, max 10:05:07, C3 10:08:20, C4 11:26:23 UTC (6 min 25 s, Sun at 82°). Paris gets a 51% partial and HCMC a 13% partial at sunset, so the event is already in the list for much of the world. ui-eclipse-partial-details.png (Luxor, 68% covered) has no countdown and no contact timing.

**Verifier corrections.** (a) The Events rows and the hero card already show a relative countdown (fmtRelative, events-panel.js:152-154, e.g. 'in 5 d 17 h'), so drop item (5)'s countdown and keep only the contact table. (b) Baily's beads and the diamond ring appear at sep ≈ rM − rS, i.e. within seconds of C2/C3. They do not appear while sep < rM − rS (that is mid-totality, which shows only the corona). Key the glow to |sep − (rM − rS)| < ~0.02·rS. (c) For partial-only observers, the HUD should say 'Maximum in…' and show the obscuration, not 'Totality in'. (d) The biggest upside is a button for non-local observers: 'Stand in the path of totality'. The global 'solar-eclipse' event already carries geo (events.js:244-245), so it can set the observer there and jump to C2 − 2 min. Without it, the default HCMC user only ever sees a 13% sunset partial. (e) Store contact times as plain numbers on the event, which the worker can structured-clone. Older cached lists need a guard (the proposal already says so).

### `sky-postcard`: Sky Postcard: share the current view as a designed image, not just a link ★

*feature · impact 5→4 · effort M→M · verdict **revise***

**Pitch.** Tap Share and pick 'Postcard'. The app renders the current frame at 2x, keeps the on-screen labels, and adds a typographic band ('Ho Chi Minh City · Tue 3 Nov 2026, 21:00 · Up now: Saturn 76° SE, Neptune 78° SSE, Uranus 29° ENE'). It then hands a ready-to-post 1080x1350 image to the phone's share sheet. Every share becomes a beautiful advert for the app.

**Current state.** Share is link-only. actions.share() sends {title, text, url} (js/app/actions.js:481-505), and the UI shows a 'Link copied' toast or a URL dialog (js/ui/view-switch.js:148-160). The social preview is the static assets/og.jpg (index.html:22), and context.js:84 uses preserveDrawingBuffer:false. Phone users cannot hide the UI to frame a shot: cinema mode is bound only to the H key (js/ui/shortcuts.js:125), and the touch UI has only the exit button (js/ui/shell.js:111). There is no image export anywhere (grep toBlob/toDataURL: none).

**Proposal.** Add rc.captureFrame({scale}) to js/render/context.js. In one task it sets a temporary pixel ratio (one-off, not per frame), calls the existing render path (postfx.render() or renderer.render), and immediately drawImage(renderer.domElement)s onto a 2D canvas. This is valid without preserveDrawingBuffer because the buffer is not presented until the task yields. It then restores the DPR. Labels: walk #labels-root children and repaint them with fillText from getBoundingClientRect, textContent and computed colour, so the postcard matches the screen. New js/ui/postcard.js composes three presets: 1080x1350 portrait, 1200x630 (link-preview ratio) and 1080x1920 story. Each gets a bottom gradient band with the place, the local date and time (ui.fmtStamp), the 'Up now' list (the same text as startSceneSummary, index.js:654-684), the selected body's sentence, the brand mark (topbar.js:17) and a short URL. Output uses canvas.toBlob('image/jpeg', .9), then navigator.share({files:[file], url}) when navigator.canShare({files}) allows it, otherwise an <a download>. Make the share button a two-option popover (Link | Postcard) and add a 'hide interface' eye button to the mobile floating column (view-switch.js:41). Text mode produces a typographic card, plus the dome chart if idea sky-dome-chart lands. Low tier: same path, with the scale capped at 1.5.

**Risks.** Per-view OpenGraph previews are impossible on static GitHub Pages because crawlers never run JS, so attaching the image to the share sheet is the honest equivalent. iOS needs user activation for share(), and the async toBlob can lose it. Prepare the blob when the popover opens, then share on the second tap. The 2x render can hitch by about 100-300 ms on the low tier, so show a spinner. About 8 KB raw against the budget. js/render must expose captureFrame through actions, because js/ui may not import render (CLAUDE.md rule).

**Files.** `js/render/context.js`, `js/app/actions.js`, `js/ui/postcard.js`, `js/ui/view-switch.js`, `css/app.css`

**Verifier evidence.** Confirmed link-only share: actions.js:481-504 passes {title,text,url} and view-switch.js:148-160 shows a toast or dialog. Grep for toBlob/toDataURL/captureFrame in js/ finds nothing. context.js:84 sets preserveDrawingBuffer:false. Cinema mode is reachable only through the H key (shortcuts.js:125) and the exit button (shell.js:111,439). No touch control enters it, and the mobile column is Globe/Sky, lock, share (css 1531 hides fs/help). Size headroom from check-size: low 3.71/3.80 MB (~90 KB), so ~8 KB fits.

**Verifier corrections.** 'Render the current frame at 2x, then compose 1080x1350 / 1200x630 / 1080x1920' does not work across devices. A 390x844 phone at 2x is 780x1688, so a 4:5 crop has to be upscaled (blurry). A 1440x900 desktop loses half its width in a portrait crop. Render each preset at its own size and aspect instead. In one task: renderer.setSize(W,H,false), postfx.setSize, camera.aspect plus updateProjectionMatrix, render, drawImage to the 2D canvas, then restore. This is a one-off reallocation, not per-frame, and it is never presented, so nothing flashes. Do not read label positions from DOM getBoundingClientRect, because they would not match the new aspect. Reproject the label feed's world directions with the temporary camera and draw them with fillText. Keep the iOS two-step approach (prepare the blob on popover open, share on the second tap). Split out a quick win: a 'Hide interface' eye button in the mobile floating column (one line calling ui.act('toggleCinema')). It is useful on its own for screenshots.

### `ar-sky-pointing`: Point your phone at the sky: compass-driven Sky view, off-screen pointers and wake lock ★

*feature · impact 5→4 · effort L→L · verdict **keep***

**Pitch.** On a phone in Sky view, tap 'Point at sky' and the view follows the phone: raise it toward the east and Jupiter is there, labelled. Edge arrows ('Saturn ↑ 79°') guide you to anything outside the frame. This is the feature people film for social media, and it turns the app from a viewer into an outdoor companion.

**Current state.** The app has no device-orientation support at all (grep deviceorientation, wakeLock: none). The Sky view is drag-only. The rig already has a sky camera with damped targets (sky.azT, altT and fovT in js/camera/rig.js:1091) and setView({mode:'sky', azDeg, altDeg, fovDeg}) (rig.js:1109-1119). The mobile floating column offers only Globe/Sky, lock and share (js/ui/view-switch.js:28-41; fullscreen and help are hidden at css/app.css:1531). In sky-night.png, Saturn is 79° up but off-screen, and nothing hints where it is.

**Proposal.** Write js/camera/aim.js, a pure-ish controller owned by main.js, plus a UI toggle in view-switch.js. The toggle shows only when view.mode==='sky', the pointer is coarse and DeviceOrientationEvent exists. iOS: call DeviceOrientationEvent.requestPermission() inside the tap handler and use webkitCompassHeading. Android: listen to 'deviceorientationabsolute'. Convert (alpha, beta, gamma) plus screen.orientation.angle to the camera forward vector in ENU with the W3C rotation-matrix formula, using preallocated Float64Array(9) scratch (no per-event allocation). Extract az and alt, low-pass filter with an adaptive exponential filter that is stronger when still, and write the rig's damped targets through a new rig.setSkyAim(az, alt). Keep the horizon level by ignoring roll, which is less nauseating. Correct magnetic declination with an 'Align' button: centre the Moon or a bright planet and tap, which stores an azimuth offset in prefs. A WMM declination grid (NOAA, public domain) is an optional extra of ~6 KB. Off-screen pointers: a DOM layer of up to 9 edge chips positioned from each body's alt/az relative to the camera az/alt/fov (from rig.getView via a read-only action), which is useful even without AR. While aiming, request navigator.wakeLock and mark the loop as animating (js/app/loop.js render-on-demand), capped at 30 fps. Not applicable in text mode.

**Risks.** Phone compasses are only accurate to 5-15° and are disturbed by metal or cases. Calibration UX is essential, and the app should say 'approximate'. Continuous rendering drains the battery, so auto-stop after 2 min idle. The iOS permission prompt and the https-only sensors mean it does not work on localhost:8080 without https. About 6-9 KB raw. aim.js touches window, so it must live in js/camera or js/app, not in the pure js/core.

**Files.** `js/camera/aim.js`, `js/camera/rig.js`, `js/main.js`, `js/app/actions.js`, `js/app/loop.js`, `js/ui/view-switch.js`, `css/app.css`

**Verifier evidence.** Grep for deviceorientation/wakeLock in js/ and index.html finds nothing. rig.js:214 has sky {az, alt, fov, azT, altT, fovT}, damped toward targets at 642-651. getView is at 1090 and setView at 1109. SKY_ALT_MAX is 89 (rig.js:45), so aiming near the zenith is possible. loop.js:311 renders continuously while rig.update() returns moving, so changing targets from sensor events keeps the loop rendering without loop changes. Grep for off-screen/edge indicators finds none, so the edge-chip part is also new. The site is served over https on GitHub Pages and has a service worker (main.js:1323), so sensors and the iOS permission prompt work in production.

**Verifier corrections.** (a) Low-pass the camera forward vector in ENU (Float64Array(3) scratch) and extract az/alt afterwards. Filtering az/alt angles causes 359↔0 wrap glitches and az jitter near the zenith. (b) No loop.js change is needed. Writing the targets through rig.setSkyAim makes rig.update report motion. Add a frame cap only if measurements show a battery problem. (c) While aiming, suspend the rig's drag inertia (vAz/vAlt) and pinch-to-fov. (d) Use screen.orientation.angle, which is already in the plan, and stop aiming when the view leaves sky mode or the page is hidden. (e) Ship the off-screen edge chips first and independently, because they help desktop and drag users too. The sensor part is phone-only and approximate (5-15° compass error).

### `sky-dome-chart`: All-sky dome chart: a live planisphere at the top of Sky now and the hero of text mode ★

*visual · impact 4→3 · effort M→M · verdict **revise***

**Pitch.** A 220-px circular sky map tops the Sky panel. It has the horizon ring with compass ticks, a twilight-tinted dome, bright stars and faint constellation lines, the ecliptic, the Moon drawn at its real phase, and every planet where it actually is. You understand the whole sky in one glance and tap a dot to select it. In text mode it finally gives no-WebGL users a picture, and in Sky view it doubles as a minimap with your field-of-view wedge.

**Current state.** Sky now is a list. Each row carries a 32-px mini compass (js/ui/sky-now.js:28-41, updated at :133-135), but no single view shows the spatial picture. Text mode (ui-textmode.png) has no visual sky at all. The Sky view gives no orientation beyond the cardinal letter at the horizon (sky-night.png). The snapshot already exposes observer upS, northS and eastS plus dirToAltAz (js/astro/snapshot.js:238-261). The decoded catalog exists in main.js (:725-736) but is not passed to the UI services (main.js:477).

**Proposal.** New js/ui/sky-dome.js renders an azimuthal-equidistant projection (r = (90−alt)/90·R) on one 2D canvas sized by DPR, with a toggle between 'looking up' and 'map' orientation. Draw order: a radial background gradient keyed to snap.observer.sunAltDeg, using the same palette as the twilight pill; the horizon ring with 16 ticks and N/E/S/W letters; and about 250 stars of mag < 3.5. Stars are projected once per second into a preallocated Float32Array(2·N) using the observer vectors (stars are static in the scene frame). Then the constellation lines at 8% alpha, the ecliptic, the bodies as colour-token dots sized by magnitude, the Moon via drawPhaseDisc at 10 px, the Sun with a glow, and labels with greedy collision avoidance. Pointer hit-testing calls ui.act('select'). In Sky view, draw the camera FOV wedge from a read-only actions.getView() (wrapping rig.getView, rig.js:1090). Pass `catalog` into services at main.js:477; it is pure data, so the R3 rule holds. The panel is collapsible and remembered in prefs. Low tier: identical (2D canvas, redrawn on 'snap' at most once per second). Text mode: mount it above the table.

**Risks.** About 7 KB raw. Star projection must reuse buffers (no per-frame typed arrays) and redraw on change, not every frame. The precession error from using J2000 star directions with the frame-detail observer vectors is under 0.4° and invisible at this scale. Label density on a small dome needs care.

**Files.** `js/ui/sky-dome.js`, `js/ui/sky-now.js`, `js/main.js`, `js/app/actions.js`, `css/app.css`

**Verifier evidence.** Sky now is a list with 32-px per-row compasses (sky-now.js:28-41, 133-135). snapshot.js:238-241 exposes upS/northS/eastS and dirToAltAz. However, main.js:358 fetches sky.json only when env.can3d (`skyJsonP = env.can3d ? fetchJson(...) : null`). The catalog is decoded inside bootRender (main.js:727) after mountUI has already run (main.js:499). services are built at main.js:477, before any catalog exists.

**Verifier corrections.** Passing `catalog` into services at main.js:477 cannot work, because it does not exist yet and does not exist at all in text mode. Use late binding instead, e.g. services.catalog as a promise or a bus 'catalog' event emitted from bootRender. In text mode, either fetch data/sky.json (159 KB extra, relative URL) or ship a tiny embedded list of ~250 stars of mag < 3.5 (a few KB) so the dome does not depend on the 3D catalog. Stars are fixed in the scene frame, but their alt/az changes with the observer vectors, so a 1 Hz reprojection into a preallocated Float32Array is correct. Value is moderate: in WebGL modes the 3D Sky view already shows this. The real win is text mode and a minimap with the FOV wedge.

### `eyepiece-portraits`: Eyepiece portraits in the body card: Jupiter's moons, Saturn's ring tilt, the real Moon ★

*visual · impact 4→3 · effort M→L · verdict **revise** · tracked under `body-card-moons-rings-libration`*

**Pitch.** Select Jupiter and the card shows it as it looks in a small telescope tonight: banded, slightly flattened, with Io, Europa, Ganymede and Callisto lined up where they really are. Saturn shows its rings at this year's true tilt, and the Moon shows the real lunar texture at the right phase, libration and bright-limb angle. It is a delightful, educational detail that no list of numbers can give.

**Current state.** drawPhaseDisc (js/ui/body-card.js:337-397) draws every planet as a flat colour-tinted 42-px disc with a terminator. Jupiter is a beige ball (ui-details-desktop.png), with no rings, no moons and no lunar features. snapshot.js:269 already calls AE.Illumination for every body but drops its ring_tilt (astronomy.js:4372). AE.JupiterMoons (astronomy.js:3568) and AE.Libration (:1684) are vendored but unused. assets/textures/moon_1024.jpg is already downloaded on every tier (check-size lists 'moon' for low, medium and high).

**Proposal.** (1) Pure: keep ringTiltDeg on the Saturn BodyState in snapshot.js, and add js/astro/moons.js jupiterMoons(tMs) → Float64Array(8) sky-plane offsets, wrapping AE.JupiterMoons and rotating Jupiter-equatorial into the observer's sky plane. (2) UI: a 240x120 'eyepiece' canvas in the card head, drawn only when its key changes, reusing the existing discKey pattern (body-card.js:275-277). Moon: orthographic per-pixel sampling of moon_1024.jpg into a cached 140x140 ImageData, including libration elon/elat and the phase terminator, then rotated by the bright-limb position angle computed like solarDiscGeometry (sky-now.js:281-300). Jupiter: procedural bands from an 8-stop palette, the Great Red Spot, 6.5% flattening, moons as labelled dots, and shadow dots when a moon transits. Saturn: front and back ring ellipses with B = ringTiltDeg and correct occlusion. Venus, Mercury and Mars: true phase. Everything is at a shared angular scale with a 10″ scale bar, a toggle for 'naked-eye / inverted telescope', and a parallactic rotation so 'up' matches the observer's horizon. Works in text mode; the cost on the low tier is negligible.

**Risks.** Jupiter's look is illustrative, so label the bands 'schematic' and keep the moon positions accurate. Loading the moon texture in the UI needs an Image with the relative URL 'assets/textures/moon_1024.jpg'. Handle a missing texture by falling back to the current disc. About 6 KB raw. JupiterMoons and Libration add small worker-free compute, which is fine at 4 Hz only when the card is visible.

**Files.** `js/astro/snapshot.js`, `js/astro/moons.js`, `js/ui/body-card.js`, `js/ui/eyepiece.js`, `css/app.css`

**Verifier evidence.** drawPhaseDisc (body-card.js:337-397) draws a flat tinted disc. ring_tilt is returned by AE.Illumination (astronomy.js:4372) but no js/ file reads it (grep ring_tilt/JupiterMoons/Libration in js/ returns nothing). AE.JupiterMoons (3568), AE.Libration (1684) and AE.RotationAxis (9007) are vendored. assets/textures/moon_1024.jpg is 1024x512 equirectangular and in every tier (check-size.mjs:47,99).

**Verifier corrections.** Orientation needs more than the bright-limb angle. Get the Moon's and Jupiter's pole position angle from AE.RotationAxis (RA/Dec of the pole) and add the parallactic angle for 'horizon up'. Libration (elon/elat) only gives the sub-observer point, not the axis rotation. Bundling the procedural Jupiter, the GRS, moon shadows, Saturn ring occlusion, the libration-correct Moon, a scale bar and an inverted-telescope toggle is L, not M. A good M first slice: the textured Moon with phase and libration, plus Jupiter's four moons as labelled dots and Saturn's ring ellipse at the true B. In text mode the texture must be loaded via new Image('assets/textures/moon_1024.jpg'), because the 3D texture loader never runs there.

### `tonight-planner`: Tonight planner: a dusk-to-dawn visibility chart, with countdowns and sparklines in Sky now

*feature · impact 4→3 · effort M→M · verdict **revise***

**Pitch.** One glance answers 'what can I see tonight, and when?'. For each body, a ribbon spans sunset to sunrise across twilight-shaded columns, glowing brighter as it climbs, with best-time markers and a live 'now' line you can drag to scrub time. Rows below the horizon stop saying 'below horizon' twice and instead say 'rises in 3 h 36 m', next to a tiny 24-h altitude sparkline.

**Current state.** Rows below the horizon print 'below horizon' in the right column (js/ui/sky-now.js:139), which repeats the DOWN badge (:146) and the 'Below the horizon' group header (:84). The rich tonight report (best time, window, equipment) appears only inside the body card (js/ui/body-card.js:218-234 via ui.tonightFor, index.js:528). The worker only offers a Sun altitude series (js/astro/worker.js:54, almanac.js:216-229).

**Proposal.** Add a pure worker op altSeries({bodyIds, observer, fromMs, toMs, n}) that generalises sunAltitudeSeries and returns one transferable Float32Array(9·n). New js/ui/tonight.js draws a 2D-canvas chart of 9 rows × 16 px from alm.night.twilight sunsetMs to sunriseMs (index.js:412-435 already fetches it). Background columns use the timebar LUT. Each body's ribbon has alpha ∝ max(0, alt)/60 in its colour token, and its rep.bestMs is marked with a dot. The now line follows clock.tMs, and pointer drag calls clock.setTime, mirroring the timebar's drag code. Mount it as a collapsible 'Tonight' card at the top of Sky now (or Events). Row polish: the right column shows the countdown ('rises in 3 h 36 m' from rs.nextRiseMs, using ui.fmt('fmtRelative')). Add a 40×14 sparkline per row from the same series, cached per observer key. One request per observer per night; 1305 AE horizon calls take a few ms in the worker. Works in text mode and on the low tier.

**Risks.** About 6 KB raw. Polar summer has no night, so fall back to a 24-h window with a 'No darkness tonight' note (the sky-now.js:193 text already exists). The chart must not reallocate per redraw; reuse the ImageData the way timebar.js does.

**Files.** `js/astro/almanac.js`, `js/astro/worker.js`, `js/ui/tonight.js`, `js/ui/sky-now.js`, `js/ui/index.js`, `css/app.css`

**Verifier evidence.** Confirmed redundant row text. In globe.png, Venus/Sun/Mercury rows show the DOWN badge, 'below horizon' in the right column (sky-now.js:139) and the 'Below the horizon' header (:84). almanac.js:443-463 tonight() already samples EVERY body's altitude on a 10-min grid from solar noon to solar noon (w.alt, SAMPLES) plus grid.sunAlt. The UI already requests 'tonight' once per night per observer (index.js:412-434), but the arrays are discarded after classification.

**Verifier corrections.** Do not add a new altSeries op or ~1300 extra AE calls. Have tonight() copy w.alt into a per-body Float32Array(SAMPLES) on each report (or one packed Float32Array(8·SAMPLES)) and return grid.sunAlt with t0 and the step. The data is computed already and arrives in the same round trip, so the chart costs zero extra compute. The 24-h sparkline is covered by the same noon-to-noon grid. The 'rises in 3 h 36 m' row text alone is an S change worth doing even without the chart.

### `timebar-truncation`: Time-bar truncation: the phone date loses its year by 1 px, and the desktop zone chip cuts the city

*bug · impact 3→2 · effort S→S · verdict **revise***

**Pitch.** The most-read element on a phone, today's date, shows 'Wed 4 Nov 20…'. On a 1440-px desktop the zone chip reads 'UTC+7 · Ho Chi …'. Both look careless in an otherwise precise instrument UI.

**Current state.** Mobile: the date column shares the 46-px row with the play button, the 'Real time' rate group (min-width 60px, css/app.css:1591) and the Now pill (js/ui/timebar.js:239). .stamp__day is ellipsized (css/app.css:1583-1590). Measured at 390x844 with t=2026-11-03T20:00Z (a Wednesday local): stamp__day scrollWidth 88 > clientWidth 87, which gives 'Wed 4 Nov 20…' in mobile.png and ui-mobile-events.png. A Tuesday fits ('Tue 3 Nov 2026', ui-mobile-settings.png), so the bug depends on the weekday. Desktop: the place inside the zone chip is ellipsized by design (css/app.css:965-970) and duplicates the top-left location chip ('UTC+7 · Ho Chi …' in globe.png and ui-details-desktop.png). Related density issue: on the full mobile sheet the pinned time-bar head (time bar + strip + tools row) takes about 255 CSS px (30% of the screen) even while reading Settings (ui-mobile-settings.png).

**Proposal.** (1) Drop the year in fmtDay on the mobile stamp when it equals the current real year, and keep it, with an accent, when the simulated year differs. (2) Add a compact rate format for the phone ('1×', '1 h/s') next to fmtRate (js/core/format.js:263-266 currently returns 'Real time'). (3) Replace the desktop chip's place with the zone abbreviation (z.abbr is already computed at js/ui/index.js:189, e.g. 'ICT'), because the location chip already names the place. Keep the full name in the tooltip and aria-label. (4) On the mobile 'full' snap with a non-Sky tab, collapse the strip and the tools row into the head (CSS on [data-sheet=full]) and remeasure in measureSheet (js/ui/shell.js:223-235). Add a smoke assertion that .stamp__day scrollWidth <= clientWidth at 390 px for all 7 weekdays.

**Risks.** Hiding the year must never hide a non-current year, which is why the rule compares against the real clock. The zone abbreviation from Intl can be 'GMT+7' on some engines; fall back to the offset label.

**Files.** `js/ui/timebar.js`, `js/ui/index.js`, `js/core/format.js`, `js/ui/shell.js`, `css/app.css`, `scripts/smoke.mjs`

**Verifier evidence.** Reproduced at 390x844@3 by stepping 7 days with __app.clock.setTime and measuring .stamp__day. Overflowing: 'Wed 4 Nov 2026' sw=88 > cw=87, 'Mon 9 Nov 2026' 88>87, 'Tue 10 Nov 2026' 89>87. Fitting: Thu 5, Fri 6, Sat 7 and Sun 8. Any wide weekday with a 2-digit date overflows, which is roughly half of all days (shots/uiv-mobile-week.png, mobile.png shows 'Wed 4 Nov 20…'). Desktop globe.png shows 'UTC+7 · Ho Chi …' (css 965-970 ellipsize .tb-tz__place). Mobile already hides the place (css 1608). tz.utcToZoned returns abbr 'GMT+7' for Asia/Ho_Chi_Minh, 'GMT+1' for Europe/Paris and 'GMT+2' for Cairo (checked with node).

**Verifier corrections.** Item (3) is wrong: z.abbr is 'GMT+7', not 'ICT', for most non-US zones, so the chip would read 'UTC+7 · GMT+7'. Hide .tb-tz__place on desktop in observer mode instead, as mobile already does (the location chip names the place), and keep the place in the tooltip and aria-label. The mobile overflow is only 1-2 px, so the least risky fix is to trim .tb-rate__value min-width (60px, css 1591) or the row gap, and/or add a compact rate label ('1×'). The 'drop the current year' rule is optional. Keep the 7-weekday smoke assertion, and make it also check 2-digit dates (e.g. Wed 11 Nov).

### `deeplink-opens-details`: A shared link with a selected body opens on the wrong tab, and the phone strip doesn't scroll to it

*bug · impact 2→2 · effort S→S · verdict **keep***

**Pitch.** The share dialog promises the link 'opens exactly what you see'. Yet a friend opening a link to your Jupiter card lands on the Sky list, and on a phone the selected chip stays scrolled out of sight.

**Current state.** js/ui/shell.js:411-418 switches to Details only on selection changes. The subscription is not {immediate:true}, so a boot selection from the URL (sel=jupiter) leaves the Sky tab active. Repro: /#…&sel=jupiter&intro=0 (ui-card-jupiter.png shows the Sky tab with the Jupiter row highlighted). url-state.js has no panel key (grep 'panel': none), yet view-switch.js:115 says the link opens 'exactly what you see'. On mobile, the strip's immediate scrollIntoView (js/ui/sky-now.js:341-347) runs before the strip is moved into the sheet (shell.js:348), so the selected chip stays off-screen (ui-mobile-details-half.png shows Sun, Moon, Mercury with Jupiter selected).

**Proposal.** In mountShell, after applyLayout() and selectTab (shell.js:449-450), call selectTab('details') when store.get().selection is set and no explicit panel was restored. Add an optional `pn=` hash key (details, events or tonight) to core/url-state.js serialize/parse and include it in shareUrl. In mountBodyStrip, re-run the scrollIntoView for the current selection on ui.on('layout') and after the first measureSheet rAF. Add a unit test in test/ for the url-state round-trip, and a smoke check that sel= gives #tab-details aria-selected=true.

**Risks.** The pn key must stay optional and backward-compatible with existing links. Make sure the Details auto-open does not override a user who deliberately chose another tab before the selection arrived.

**Files.** `js/ui/shell.js`, `js/ui/sky-now.js`, `js/core/url-state.js`, `test/`

**Verifier evidence.** Reproduced. Desktop /#…&sel=jupiter&intro=0 gives tabs sky:true, details:false, store selection=jupiter, ui.panel=sky (shots/uiv-deeplink-desktop.png). Mobile gives strip scrollLeft=0 with the Jupiter chip at x=549-651 while the strip ends at 378, so it is off-screen (uiv-deeplink-mobile.png). shell.js:411-418 subscribes to selection without {immediate:true}. sky-now.js:341-347 calls scrollIntoView immediately, before applyLayout moves the strip into the sheet (shell.js:348). url-state.js has no panel key. view-switch.js:115 promises the link 'opens exactly what you see'.

**Verifier corrections.** Simplest fix: run the shell's selection handler once at mount, only when activeTab is 'sky' (that is the subscription's own guard), so a user-chosen tab is never overridden. Re-run the strip's scrollIntoView on ui 'layout' and after the first measureSheet rAF. The pn= hash key is optional and could be skipped. Details-on-selection already covers the main case, and a new key adds url-state surface for little gain.

### `event-glyphs-and-ics`: Event glyphs that show the event, and 'Add to calendar' (.ics) offline

*ux-polish · impact 3→2 · effort S→S · verdict **keep***

**Pitch.** New Moon, First Quarter and Full Moon each show their real phase. A conjunction shows two dots in both planets' colours, and an eclipse shows the actual overlap. One tap on 'Add to calendar' puts the Mars–Jupiter pairing or the 2027 eclipse into your phone's calendar with a reminder and a deep link back to that exact sky.

**Current state.** events-panel.js:27-41 maps each kind to one generic icon. Every Moon phase uses the same half-lit 'moon-phase' glyph, so New Moon, First Quarter and Full Moon look identical in ui-events-desktop.png and ui-mobile-events.png. The 'Mars–Jupiter conjunction' icon is Mars-coloured only (eventColor at :33-41). There is no calendar export (grep ics/VEVENT: none).

**Proposal.** Replace the icon span with a 28-px canvas or SVG per event. moon-phase: drawPhaseDisc(frac 0, .5, 1 or .5, with the lit side taken from the kind's title). conjunction: two dots in var(--body-a) and var(--body-b) whose spacing scales with ev.separation. Eclipse: Sun and Moon discs offset by the obscuration. Opposition: a Sun-Earth-planet alignment. Add 'Add to calendar' to the hero card and to each row's overflow menu. It builds an RFC 5545 VCALENDAR with DTSTART in UTC, SUMMARY ev.title, DESCRIPTION ev.detail plus shareUrl with t= and sel=, and a VALARM 30 min before. Download it as a Blob via <a download> ('mars-jupiter-conjunction.ics'), with an 'All eclipses in the next year' bundle. Fully offline, about 2.5 KB raw. Works in text mode.

**Risks.** Fold long lines and escape commas and semicolons per RFC 5545. iOS Safari opens .ics files as 'Add to Calendar' in a sheet, which is fine. Keep glyphs cached per event id so a re-render does not redraw dozens of canvases.

**Files.** `js/ui/events-panel.js`, `js/ui/body-card.js`, `js/ui/ics.js`, `css/app.css`

**Verifier evidence.** events-panel.js:27-30 maps every 'moon-phase' to one icon. In ui-events-desktop.png, New Moon, First Quarter and Full Moon show the identical half-lit glyph, and the Mars–Jupiter conjunction icon uses Mars's colour only (eventColor :33-41 uses ev.bodyId). Grep for ics/VEVENT finds nothing.

**Verifier corrections.** Prefer inline SVG glyphs, built like icons.js and coloured by CSS variables, over a canvas per row. They are crisp, cheap and need no cache. For .ics on iOS, blob downloads behave inconsistently, especially in standalone PWA mode. Use navigator.share({files:[new File([ics],'x.ics',{type:'text/calendar'})]}) when canShare allows it, and fall back to <a download>. Use the share URL from actions.shareUrl() with t= and sel= set to the event.

### `night-vision-mode`: Night-vision red mode with a screen wake lock for real observing

*feature · impact 3→2 · effort S→S · verdict **revise***

**Pitch.** People actually take this app outside. One switch turns the whole screen deep red and dim, so your dark adaptation survives. A wake lock keeps the phone from sleeping while you stand under the stars, which is the feature serious stargazing apps all have.

**Current state.** There is no red or night mode (grep nightMode/red mode: none). theme-color is fixed at #03060d (index.html:10). There is no Wake Lock usage. Settings has only quality, time display, 24 h and Earth lock (js/ui/settings.js:26-74).

**Proposal.** Add a Settings switch (and a free shortcut, e.g. Shift+N) that toggles html.is-red. An inline SVG filter (<feColorMatrix> mapping luminance to the red channel, with zero green and blue) is applied as `html.is-red{filter:url(#pc-red) brightness(.55)}`, which covers the canvas, the DOM labels and the UI in one compositing pass. Set meta theme-color to #000 while active. Persist the setting via core/prefs. While red mode or Sky view is active, request navigator.wakeLock.request('screen') and re-acquire it on visibilitychange. On the high tier, the same matrix can alternatively be applied as a final postfx pass to avoid the CSS filter cost. Works in text mode (DOM).

**Risks.** A full-screen CSS filter adds a GPU compositing pass that could cost 1-3 ms per frame on low-tier phones. Measure it with window.__app.stats(), and fall back to a red multiply overlay if the governor downgrades. The wake lock needs https and a visible document. The shortcut must not collide with the existing map (help.js:13-52).

**Files.** `index.html`, `js/ui/settings.js`, `js/ui/shortcuts.js`, `js/core/prefs.js`, `css/app.css`

**Verifier evidence.** Grep finds no red or night mode and no wakeLock. theme-color is fixed (index.html:10). Settings has only quality, time display, 24-h and Earth lock (settings.js:26-60). The KeyN handler (shortcuts.js:97) ignores shiftKey, so Shift+N would also trigger goLive unless it is checked first.

**Verifier corrections.** Avoid `filter:url(#svg feColorMatrix)` on the whole page. SVG reference filters often fall off the GPU fast path (notably in Safari and Firefox), which is exactly the low-end-phone risk. Use a chain of CSS filter functions, which are accelerated everywhere, e.g. `filter: grayscale(1) sepia(1) saturate(5) hue-rotate(-50deg) brightness(.5)`, or redefine the UI colour tokens to reds and filter only #scene. Put the Shift+N check before the plain KeyN branch, or use another key. Merge the wake-lock helper with the one in ar-sky-pointing instead of building it twice. The audience claim ('people actually take this app outside') is unproven for a globe explorer, so impact is modest.

### `first-run-touch-onboarding`: Touch-aware first run: gesture tips, a 3-step coach mark, an intro caption and an Install button

*ux-polish · impact 3→3 · effort M→M · verdict **keep***

**Pitch.** A phone user currently gets keyboard tips ('Press V', 'Space pauses', 1–9) and a 'Keyboard shortcuts' button, with no idea that you can tap a beam or drag the timeline. Three gentle spotlight hints and gesture-specific tips make the first minute feel designed for the device in their hand. A proper install flow lets the app live on the home screen.

**Current state.** The loader tips are keyboard-centric and shown on every device (index.html:309-317). The Sky tab footer says 'Tip: press 1–9 … V' (js/ui/sky-now.js:90-91), and the Details empty state and Settings show kbd hints and a 'Keyboard shortcuts' button on phones (body-card.js:51, settings.js:59, ui-mobile-settings.png). The help button is hidden on mobile (css/app.css:1531) and help.js covers only keys. The intro (js/app/intro.js:1-11) has no on-screen caption. PWA: manifest.webmanifest has no `screenshots` (Chrome's richer install dialog needs them), no `shortcuts` and no `launch_handler`, and nothing captures beforeinstallprompt.

**Proposal.** Branch on body.is-coarse (set at index.html:297) and ctx.env.coarse. Use gesture copy for loader tips and the Sky footer ('Tap a beam to meet that world', 'Drag the time bar to travel', 'Pinch to zoom'), and hide kbd hints on coarse pointers via CSS. Add a one-time coach sequence after the intro, stored in prefs `coachSeen`. It has three steps (a beam/body chip, the scrubber, the Globe/Sky switch), each a spotlight cut-out using a CSS mask on the target's rect plus one sentence and Next/Skip. It respects reduced motion and is announced through bus 'announce'. Intro caption: when beams launch at 2.9 s, fade in a title card ('Ho Chi Minh City · 21:00 · 3 worlds above you'). Mobile '⋯' button: help with a gestures section, hide interface, fullscreen. PWA: add wide and narrow screenshots (about 120 KB each JPEG, not runtime-fetched, so outside the tier budgets; staged-site total stays well under the 12 MB budget), shortcuts (Sky view './#view=sky', Events), launch_handler {client_mode:'focus-existing'}, and capture beforeinstallprompt to show an 'Install app' button in About, plus a one-time iOS 'Add to Home Screen' hint when not standalone.

**Risks.** Coach marks are easy to make naggy, so show them once and make them skippable with Esc or a tap outside. The intro caption must not violate the single-console.info boot rule or delay ready. Manifest screenshot sizes must follow Chrome's aspect rules (≤ 2.3:1).

**Files.** `index.html`, `manifest.webmanifest`, `js/ui/sky-now.js`, `js/ui/help.js`, `js/ui/coach.js`, `js/ui/view-switch.js`, `js/app/intro.js`, `js/ui/about.js`, `css/app.css`, `assets/`

**Verifier evidence.** index.html:309-317 loader tips are keyboard-centric on every device. sky-now.js:90-91 shows a kbd tip, and body-card.js:51/55 show kbd ghosts and 'press 1–9'. settings.js:59 shows a 'Keyboard shortcuts' button, visible on mobile in ui-mobile-settings.png along with the 'L' kbd chip. css 1531 hides help on mobile. No CSS hides kbd under body.is-coarse (only 1710 and 1716-1718 use it). manifest.webmanifest has no screenshots, shortcuts or launch_handler. Grep for beforeinstallprompt finds nothing. sw.js exists, so the app is installable.

**Verifier corrections.** Ship it in order of value and cost. (1) Coarse-pointer copy and CSS hiding kbd hints: S, no risk. (2) Manifest shortcuts and launch_handler plus the beforeinstallprompt 'Install' button in About: S. (3) The intro caption is best emitted as a bus event from js/app/intro.js and rendered by js/ui, so intro stays DOM-free like the rest of js/app. (4) Coach marks last and optional, since they are the naggy part. Manifest screenshots are not in the tier budgets, but they do count toward the staged 12 MB budget (6.53 MB now), so that is fine.

### `sky-ribbon-scrubber`: Sky-ribbon scrubber: true sky colours, Moon and selected-body bands, fling and haptics

*visual · impact 3→2 · effort M→M · verdict **revise***

**Pitch.** The time bar becomes a miniature of the sky's day: amber golden hours, violet twilights and an indigo night. A silver thread marks when the Moon is up, glowing by phase, and a coloured thread marks when your selected planet is up. Flick it on a phone and time coasts, with a soft haptic tick at each sunrise.

**Current state.** js/ui/timebar.js:45-50 uses six muted navy colours (C_DAY #2d4a6b … C_NIGHT #0a0d18), so sunset and sunrise read as flat blue/navy (bottom of globe.png and sky-night.png). Only event ticks are drawn (drawTicks :664-692). There is no Moon or selected-body information. A drag release only re-centres (:829-836) with no momentum, and there is no haptic feedback.

**Proposal.** Rebuild buildLut (:59-75) with a golden-hour amber band (+6°…−0.8°), a rose-to-violet civil band, an indigo nautical band and near-black night, keeping label contrast ≥ 4.5:1 via the existing sheen. Add a 3-px bottom band where the Moon is up, with brightness ∝ phaseFrac, and a 3-px top band in var(--body-<sel>) where the selected body is up. Both come from the altSeries op (idea tonight-planner), cached in a preallocated Float32Array alongside `series`. Draw eclipse spans as gold bars. Touch: on release with |v| > 0.4 px/ms, start a decaying clock tween (clock.setTime with animateMs). Fire navigator.vibrate(4) when crossing midnight or sunrise on Android, guarded by reduced motion. Everything reuses lineImg (no per-frame allocation, rule R5). Works the same in text mode and on the low tier.

**Risks.** Too much colour fights the UI. Keep saturation low and test with the twilight pill colours. vibrate is Android-only and must be silent elsewhere. Depends on the altSeries op from tonight-planner for the body bands. The Moon band can use a 2-sample-per-hour series to stay cheap.

**Files.** `js/ui/timebar.js`, `css/app.css`

**Verifier evidence.** timebar.js:45-50 has six muted navy colours (C_DAY #2d4a6b … C_NIGHT #0a0d18), labelled 'SPEC F.2'. drawTicks :664-692 draws event ticks only. endDrag :829-836 re-centres with no momentum. Bottom of globe.png shows the flat blue/navy ribbon.

**Verifier corrections.** Drop the fling and haptics. Momentum on a time scrubber makes accidental multi-hour jumps easy and fights the existing drag-relative-to-window model, and vibrate() is Android-only. For the Moon and selected-body bands, do not depend on tonight-planner's altSeries. The ±12 h window scrolls, so generalise sunAltitudeSeries (almanac.js:216-229) into a body-parameterised series op. That is about 5 lines, and it caches like `series`. Keep the palette change subtle and check the 4.5:1 label contrast against the new amber band. It also changes a SPEC-documented palette, so update the SPEC/docs.

### `picker-place-preview`: Location picker that previews each place's sky: local time, day or night, Moon up

*ux-polish · impact 2→2 · effort S→S · verdict **revise***

**Pitch.** Typing 'San' shows not just Santiago and San Diego but '06:14 · sunrise in 12 min' or '23:40 · night, Moon up' beside each. Choosing where to stand becomes part of the fun of travelling the sky.

**Current state.** cityModel (js/ui/location.js:208-218) shows the name, admin/country and coordinates only (ui-search-desktop.png, ui-mobile-search.png). A cheap solar-altitude formula already exists but is private to the scrubber (sunAltApprox, js/ui/timebar.js:92-102). The tz service can convert any zone (ui.zoned uses services.tz.utcToZoned, index.js:174-190).

**Proposal.** Move sunAltApprox and dayFraction into a pure helper (js/astro/quick.js, no AE dependency, so it stays tiny). For each offline or online result with p.tz, compute the local clock (ui.fmtClock(t, {tzName: p.tz})) and the Sun altitude at the simulated time. Render a meta chip with a day, civil, nautical or night glyph coloured from the timebar palette, e.g. '06:14 · Sunrise in 12 min' when the Sun is within ±1° of rising. Optionally add 'Moon up' using the snapshot's Moon direction and the place's up vector (cheap dot product). Debounce with the existing 400 ms search cycle. Recent places get the same chip.

**Risks.** Online results without tz need tz.approxTzForLon, marked approx. The low-precision Sun (~0.1° near the present) is fine for a chip but must not be reused for almanac numbers. About 1.5 KB raw.

**Files.** `js/ui/location.js`, `js/astro/quick.js`, `js/ui/timebar.js`, `css/app.css`

**Verifier evidence.** location.js:208-218 cityModel shows the name, admin/country and coordinates only. sunAltApprox is private in timebar.js:92-102. snapshot BodyState carries subLatDeg/subLonDeg for every body (used by body-card.js:262).

**Verifier corrections.** There is no need to move sunAltApprox into a new js/astro/quick.js. The current snapshot already has the Sun's and the Moon's sub-points. A place's Sun altitude is ≈ 90° − its great-circle distance to the sub-solar point (error < 0.01° for the Sun). 'Moon up' is the same test with ~1° of parallax slack. One haversine per result, at the simulated time, with no new module. Use ui.fmtClock(t, {tzName: p.tz}) for the local time, as proposed.

### `i18n-a11y-readiness`: i18n and accessibility readiness: a string table, Intl-driven dates, Vietnamese first, and contrast and transparency modes

*engineering · impact 3→2 · effort L→L · verdict **revise***

**Pitch.** The app's natural audience includes its owner's Vietnamese-speaking community (the device-timezone boot lands on Ho Chi Minh City), yet every word is hard-coded English. A small string table plus Intl formatting makes the app speak Vietnamese natively. Honouring high-contrast and reduced-transparency settings makes the glass UI readable over a bright daytime sky.

**Current state.** All copy is inline literals, e.g. TWILIGHT_LABEL (js/ui/sky-now.js:20-22), the WEEKDAYS, MONTHS and MONTHS_LONG arrays (js/ui/index.js:34-37), fmtRate 'Real time' (js/core/format.js:266), the help table (help.js:13-52) and the events copy. Almanac formatters hard-code 'en-US'/'en-GB' (js/astro/almanac.js:243-245), and <html lang='en'> and the manifest lang are fixed. css/app.css has no forced-colors, prefers-contrast or prefers-reduced-transparency rules (grep: none), while the panels are rgba(12,16,26,.78) glass that sits over a pale daytime sky in Sky view (ui-eclipse-partial-details.png).

**Proposal.** Add js/core/i18n.js (pure): t(key, vars) with Intl.PluralRules, and locale packs data/i18n/en.json (inlined default) and vi.json fetched on demand (relative URL). Replace the hand-rolled weekday and month arrays with Intl.DateTimeFormat(locale, {weekday:'short', month:'short', timeZone}).formatToParts in the zoned() path. Use Intl.RelativeTimeFormat for 'in 5 d 11 h' and Intl.NumberFormat for km and AU. Thread the locale into almanac's timeFormatter. Detect navigator.language, add a Settings selector, and persist it via prefs. Keep IAU constellation names in Latin. CSS: `@media (prefers-reduced-transparency: reduce)` → solid var(--panel-solid); `(prefers-contrast: more)` → brighter --muted and --faint plus 1-px --line-2 borders; `(forced-colors: active)` → visible borders on .glass, chips and the scrubber thumb, using system colours. Add a test asserting no missing keys between en and vi.

**Risks.** Touching every UI string is a large, error-prone sweep that is best done incrementally, file by file, with an English fallback. Vietnamese strings run about 20-30% longer, which will re-trigger the time-bar truncation (fix timebar-truncation first). The vi.json payload (~10 KB) is fetched only when selected, but the crawler counts only module imports, so keep it as data, not a module.

**Files.** `js/core/i18n.js`, `js/ui/index.js`, `js/ui/*.js`, `js/core/format.js`, `js/astro/almanac.js`, `data/i18n/`, `css/app.css`, `test/`

**Verifier evidence.** Hard-coded English confirmed: sky-now.js:20-22, index.js:34-37 WEEKDAYS/MONTHS, format.js:266 'Real time', almanac.js:243-245 'en-US'/'en-GB'. css/app.css has no prefers-contrast, forced-colors or prefers-reduced-transparency rules (grep). However, .glass is already the solid --panel-solid on low tier and on coarse medium (css 231-248). Blur and .78 alpha apply only on high, or on medium with a fine pointer. ui-eclipse-partial-details.png shows the panel reading fine over the pale daytime sky.

**Verifier corrections.** Split it. Ship the a11y media queries now (S): prefers-reduced-transparency gives .glass a var(--panel-solid) background with no backdrop-filter, plus prefers-contrast and forced-colors borders. The full i18n sweep is L and touches every UI file. The 'Vietnamese audience' premise only reflects the dev machine's timezone, since the boot picks the largest city in the device's zone. It does not answer the 'breathtaking' brief, so defer it until a non-English audience is confirmed. If done later, move WEEKDAYS/MONTHS to Intl formatToParts first; that is the cheapest step and also helps 12/24-h correctness.

## Lens: Performance, loading & robustness

The runtime is in better shape than most WebGL apps. Rendering is on demand (0 frames/s when paused in orbit, about 2/s at Live 1x). The astronomy is cheap: a 'frame' snapshot costs 0.14-0.3 ms, a 'full' one 0.24-0.5 ms, and the 367-day event search 56 ms in the worker. Every module call is guarded. Context restore works (tested with WEBGL_lose_context). The cost goes into the edges around it. (1) Loading is serial and all-or-nothing. Textures are requested only after all 86 modules (import depth 5, 3 modulepreloads) and compile; until they arrive the globe is a flat blue ball (perf-placeholder-globe.png). One 4096x2048 texSubImage2D blocks the main thread for 399 ms at boot. (2) Two layout reads per frame in the time bar take 19-31% of the main thread during time-lapse. (3) The governor measures the gap between frames (rAF cadence), not how long a frame takes to render. Under a 30 Hz rAF cap it would drop an RTX desktop to Low within 9 s (simulated in Node, not seen in a browser). (4) The offline cache has no automated coverage, and its updates are not atomic. The biggest opportunity is a progressive, GPU-friendly texture pipeline: a tiny preview the moment the JS lands, then the tier's maps uploaded without freezes, and later GPU-compressed and zoom-streamed 8K imagery. That one pipeline fixes time-to-first-globe, jank, VRAM and the 'wow' factor together.

### `instant-earth-progressive-textures`: Instant Earth: 15 KB preview textures, early tier-aware preloads, and a sharpen-in instead of a flat blue ball ★

*performance · impact 5→3 · effort M→L · verdict **revise***

**Pitch.** The globe appears as a recognisable, lit Earth in the first rendered frame, even on a slow phone network, and then visibly 'focuses' into the 4K maps a moment later. There is never a featureless blue sphere, and the loader goes away seconds earlier.

**Current state.** Placeholders are 1x1 flat colours (js/render/textures.js:35-37, 141-156), so until the maps land the globe is a flat blue ball (screenshot shots/perf-placeholder-globe.png, taken with the maps forced to 404). Textures are requested only inside bootRender, after every render module has loaded and been created (js/main.js:821-822). The loader then waits for them or 5 s (js/main.js:846). I throttled a local, uncompressed server to 150 ms RTT and 9 Mbps: the render context existed at 4.9 s, the first frame at 5.9 s and ready at 6.0 s. At 400 ms and 1.6 Mbps: context at 15.5 s, ready at 19.7 s. The textures sat idle behind JS the whole time. Only three/astronomy/main.js are modulepreloaded (index.html:40-42). The module graph is 86 files with an import chain 5 deep: main -> render/context -> render/postfx -> EffectComposer -> CopyShader. That is 4 extra round trips. The three.js modulepreload is unconditional, so text-mode browsers download 692 KB raw (172 KB gzipped) they never run.

**Proposal.** 1) Preview assets. Add earth_day_preview.webp (512x256, about 10 KB) and earth_night_preview.webp (about 5 KB). Produce them with a new zero-npm-dependency scripts/build-textures.mjs that drives the already-vendored headless-Chrome tooling (scripts/lib/chrome.mjs): draw the 4K source into a canvas and export with canvas.toBlob('image/webp', 0.8). Commit the outputs with sha256 and a --check mode, like build-sky. 2) textures.js. Add a 'preview' state: get(key) returns the preview texture once it has decoded (createImageBitmap, small), and onReady still fires for the full map. Change keysForTier so 'critical' means the previews, and the tier's maps become 'primary'. 3) main.js. Mark the app ready when the previews are uploaded and compile is done. The loader can then hide at the first real frame, typically about 1 RTT after the JS, and the 5 s timeout becomes a rare fallback. 4) Earth shader. When the full map arrives, keep the preview bound as uDayPrev and tween uSharpen from 0 to 1 over 600 ms (mix(prev, full, k)). It reads as a lens focus pull, not a pop. Skip the tween with reduced motion. 5) Early fetches from the inline feature-detection script (index.html:270-351), which already knows webgl2, importmap, renderer string, maxTex, coarse and saveData. When can3d is true, inject <link rel=modulepreload> for a committed list of the boot graph (generated by the same crawl check-size uses, scripts/lib/modgraph.mjs, and verified by a test like repo.importmap.test.mjs). Also inject <link rel=preload as=fetch crossorigin fetchpriority=high> for the previews and fetchpriority=low for the guessed tier's day and night maps. Port the ~15 lines of detectTier needed for the guess into ES5, and add a test that runs both versions on a probe matrix. 6) Move the unconditional three.js modulepreload (index.html:40) into that injection, so text mode stops downloading it. Size: about +15-20 KB. Low becomes about 3.73 MB against its 3.80 MB budget (tight but fits, and idea low-tier-texture-diet frees about 0.6 MB). Low tier: the same previews, with the 2K maps afterwards. Text mode: nothing new is fetched, and it saves the three.js download.

**Risks.** Duplicating detectTier in the inline script can drift, so the equivalence test is required. A wrong guess only wastes one prefetch. Preloads the page never uses log 'preloaded but not used' warnings, not errors, so the clean-console rule holds. Use credentials:'same-origin' so preload and fetch() match. Throttled numbers came from an uncompressed local server; on GitHub Pages the gzipped JS (about 0.62 MB against 2.0 MB raw) shortens the JS phase about 3x, but textures (already compressed) and round-trip latency do not shrink. The preview step must keep the 'no per-frame allocation' rule: the tween is a uniform only.

**Files.** `js/render/textures.js`, `js/main.js`, `index.html`, `js/render/earth.js`, `js/render/shaders/earth.glsl.js`, `scripts/build-textures.mjs`, `scripts/check-size.mjs`, `test/repo.importmap.test.mjs`

**Verifier evidence.** Code confirms the ordering. boot() awaits uiModP and mountUI (main.js:498), then bootRender awaits all 14 render modules (main.js:693, importRenderStack main.js:315-344) and creates every module before textures.load(keys.critical) at main.js:821-822. The ready race (texture or 5 s) is at main.js:846. Placeholders are 1x1 flat colours (textures.js:35-37, 141-156). shots/perf-placeholder-globe.png shows the flat blue ball. Only three, astronomy-engine and main.js are modulepreloaded (index.html:40-42). check-size reports 86 modules. One inaccuracy: the inline probe (index.html:276-298) does not know saveData. It records webgl2, importmap, renderer and maxTex and only adds the is-coarse class. I did not reproduce the throttled timings because smoke has no throttle flag, but the waterfall follows from the code.

**Verifier corrections.** The core win is starting texture bytes and the module graph in parallel with the JS. Keep that, but drop the ES5 port of detectTier and its equivalence test. 1) From the inline script, preload only what every tier needs: the 'night' map (keysForTier always lists it, textures.js:90) plus a tiny preview if you add one. Start the tier-specific day map from main.js boot() right after detectTier/governor.pin (main.js:395-410), before `await uiModP`. Pass the in-flight fetch promise into createTextureStore, or let the matching fetch() reuse the preload (same credentials and mode). 2) Put a static <link rel=modulepreload> list for the boot graph in index.html. Generate it with scripts/lib/modgraph.mjs and verify it in repo.importmap.test.mjs. That is simpler than JS injection, and text mode is rare. 3) The preview plus sharpen tween is optional polish. It helps mostly because the first-visit intro starts zoomed out, but it needs a uniform plus a second sampler in every earth variant. Full scope is L, not M.

### `timelapse-layout-thrash`: Fix the time-lapse layout thrash: the scrubber and view-insets force two synchronous layouts every frame

*bug · impact 4→2 · effort S→S · verdict **revise***

**Pitch.** Time-lapse, the signature interaction, is today partly a DOM benchmark. Removing two per-frame layout reads and an uncached trig gradient frees 20-30% of the main thread, which turns into visibly smoother time-lapse on phones and less battery drain.

**Current state.** I CPU-profiled 4 s at 86400x on the real GPU (desktop, low tier). ui/timebar.js frame() costs 1216 of 4135 ms (29%). getBoundingClientRect alone is 776 ms of self time, coming from resizeCanvas() at js/ui/timebar.js:459-460, which draw() calls every rAF (timebar.js:706-707). drawGradient re-runs dayFraction trig for every pixel column every frame (timebar.js:525-546, 251 ms self). In mobile emulation (390x844@3, 4x CPU throttle) the time bar takes 31% (1421/4652 ms), with getBoundingClientRect at 981 ms. bindViewInsets' measure() (js/main.js:1021) adds another 124 ms. Its MutationObserver watches 'style' on the whole #ui-root subtree (js/main.js:1050), and the time-bar thumb's style.transform write every frame (timebar.js:716) triggers it, so it reads 2-3 rects per frame too. core/tz.js readParts (Intl formatToParts plus new Date per call, tz.js:122-141) costs another 120 ms. Long-animation-frame entries during play name 'app/loop.js:frame | ui/timebar.js:frame' at 140-170 ms.

**Proposal.** 1) timebar.js: keep cssW/cssH/dpr from a ResizeObserver on `scrub` that sets geomDirty. resizeCanvas() never reads layout inside draw(). xFromEvent reads the rect once on pointerdown and caches it for the drag. 2) Gradient cache: render the day/night gradient into the existing 1-pixel lineCanvas, but 3x the window width, centred on the window. Each frame drawImage the slice at a sub-pixel offset of (win.start - cacheStart)/span*cw. Recompute only when the observer, rate bucket (halfWindowFor), series key or drift (more than one span) changes. That turns O(width x trig) per frame into one blit. 3) main.js bindViewInsets: drop 'style' from attributeFilter (keep class and data-layout). The ResizeObserver it already attaches to .panel/.timebar/.sheet (main.js:1052-1058) covers size changes. 4) core/tz.js: memoise the UTC offset per (tz, 15-minute bucket) in a small Map. When the offsets at the bucket's start and end agree, derive the fields with Date.UTC arithmetic instead of formatToParts. That stays exact for 1000-3000, including LMT, because a mismatched bucket falls back to Intl. Add a unit test against the current implementation over random instants. 5) Add a test hook: count getBoundingClientRect calls inside rAF during smoke time-lapse and assert 0 (see the regression-gates idea).

**Risks.** core/tz.js must stay pure: a Map memo is fine. The gradient cache must handle the range-loop window (win.range) and the drag-recentre tween. Invalidate it on observer change. The thumb transform keeps its per-frame write, which is cheap. No size impact. Text mode benefits too, because the time bar runs without WebGL.

**Files.** `js/ui/timebar.js`, `js/main.js`, `js/core/tz.js`, `test/core.tz.test.mjs`

**Verifier evidence.** Cited code is accurate. resizeCanvas reads scrub.getBoundingClientRect() on every draw (timebar.js:459-460, 706-707). drawGradient runs dayFraction trig per column when span > 6.5 d (timebar.js:525-546); at 86400x, halfWindowFor gives ±30 d (timebar.js:118-124), so the wide path is taken. The thumb write is at timebar.js:725, not 716. I measured with an --init shim on the real GPU, low tier, 86400x, over 3 s (shots/perfv-timelapse.png): 530 getBoundingClientRect calls, all inside rAF, across 446 rendered frames at 143 fps. They totalled 198 ms, which is about 0.44 ms per frame (6.6% of wall time), not the 29% from the profiler. The rate is about 1.2 calls per frame, not 3. The thumb stays centred during plain time-lapse, so its transform string does not change and bindViewInsets' style MutationObserver does not fire every frame; that would only happen in range loops and tweens. No long-animation-frame entry over 50 ms was seen.

**Verifier corrections.** The ResizeObserver already exists: timebar.js:874-875 observes scrub and sets geomDirty. The fix is one line: only call getBoundingClientRect in resizeCanvas when geomDirty, and cache the rect for xFromEvent on pointerdown. Dropping 'style' from bindViewInsets' attributeFilter is fine but matters only during range loops and drags. A tz.js memo with a 15-minute bucket is nearly useless at time-lapse rates, because 86400x advances 10-24 minutes of sim time per frame. If you memoise, bucket per (tz, UTC day) and fall back to Intl when the offsets at the day's start and end differ. The gradient cache is a nice-to-have. Overall gain: modest smoothness on phones.

### `governor-measures-work-not-cadence`: Governor: measure frame work (CPU + GPU timer queries) instead of rAF cadence. Stop downgrading capable GPUs under 30 Hz caps, and learn to step up

*bug · impact 4→3 · effort M→M · verdict **revise***

**Pitch.** A gaming laptop on battery stops silently dropping to the Low tier mid-intro. An M2 MacBook Air or Iris Xe laptop, which the regex sends to Medium, can earn High after a few seconds of measured headroom. The choice is remembered for the next visit.

**Current state.** The governor is fed the gap between rAF callbacks (js/app/loop.js:239, 370-378). It steps down when that gap's EMA exceeds 1.3 x 16.7 ms for 2 s (js/core/quality.js:146, 194-211). Chrome's Energy Saver and Safari's Low Power Mode cap rAF at 30 Hz with an idle GPU. I simulated createGovernor with dt=33.3 ms: high drops to medium at 2.0 s and to low at 9.0 s. With DPR 2 the steps land at 2/9/16/23 s. A 48 Hz panel with jitter (21.9 ms) also drops to low. The first-visit intro alone renders continuously for up to 9 s (main.js:1205), and sky view on High renders continuously for twinkle. Changes are downgrade-only and never persisted. The DISCRETE_GPU regex (quality.js:49) maps base Apple M-series, 'Apple GPU' (Safari) and Iris Xe to medium for good. Under webdriver the governor is null (main.js:841), so CI never exercises it. EXT_disjoint_timer_query_webgl2 is exposed here. Measured GPU time at 1440x900: low 0.14 ms (orbit), medium 1.9 ms at DPR 1.5, high 3.46 ms at DPR 2.

**Proposal.** 1) Minimal fix (S). The loop already ticks rAF when idle, so track the median dt of non-rendered ticks as `cadenceMs` and pass budget = max(16.7, cadenceMs) to governor.sample(). 2) Proper fix. Sample frameWorkMs = (performance.now() after labels.update) - (frame start), plus GPU ms where the extension exists: a preallocated ring of 4 WebGLQuery objects in render/context.js, begun and ended around rc.render(), read 2-3 frames later when QUERY_RESULT_AVAILABLE and not GPU_DISJOINT. That allocates nothing per frame (R5). Governor input = max(cpuWork, gpuMs), compared against the budget. 3) Hysteresis upgrade. If the work EMA stays under 35% of budget for 10 s of rendered frames and the tier is below the ceiling+1 cap, compile the next tier's materials first (see hitch-free-tier-switch), switch, and fall back on the first downgrade signal. Never oscillate: one upgrade attempt per session per tier. 4) Persist 'quality.learned' in prefs, keyed by renderer string, and start there next time. detectTier stays the cold-start guess. 5) Add a `#gov=1` hash override so smoke can force the governor on under webdriver, plus Node unit tests driving sample() with synthetic cadence/work traces (30 Hz idle, real overload, single 400 ms hitch).

**Risks.** The timer-query extension is missing on Safari and most mobile browsers; CPU work time alone is then a fair proxy, because mobile budgets are already 33.4 ms. GPU timer results are coarse or disjoint at times; ignore those samples. Upgrading on mobile risks thermal throttling later, so keep the coarse-pointer ceiling at medium. quality.js stays pure: the GPU sampling lives in render/context.js and only numbers cross over.

**Files.** `js/core/quality.js`, `js/app/loop.js`, `js/render/context.js`, `js/main.js`, `js/core/prefs.js`, `test/core.quality.test.mjs`

**Verifier evidence.** loop.js:239 computes dt from rAF timestamps and loop.js:370-378 feeds governor.sample(dt) on consecutive rendered frames. quality.js:146 and 194-211 hold the budget, the 1.3x threshold, 2 s over-time, 5 s cooldown and downgrade-only stepDown. Tracing sample() with dt=33.3 confirms high to medium at 2 s and to low at 9 s (DPR steps at 2/9/16/23 s with DPR 2). DISCRETE_GPU (quality.js:49) only matches Apple M Pro/Max/Ultra. The governor is null under webdriver (main.js:841). The cost of a wrong downgrade is larger than stated: forcing tier switches on the real GPU produced a 495 ms long animation frame for high to medium and 1820 ms for medium to low. A 30 Hz-capped laptop would therefore freeze twice during the intro and end on low.

**Verifier corrections.** Do the minimal fix first (S). The loop already ticks rAF headless from loop.start() (main.js:509), before rendering begins, and while idle. Take the median dt of non-rendered ticks as the display cadence and use budget = max(16.7, cadence). Also persist the learned tier per renderer string in prefs. Treat CPU work time and GPU timer queries only as a gate on top of cadence, never as a replacement. Without EXT_disjoint_timer_query (Safari, most mobile), CPU work time cannot see GPU-bound overload, and today's cadence signal is what catches it. Drop step-up, or keep it out of the first version: switching up costs the same 0.5-1.8 s hitch until hitch-free-tier-switch lands.

### `battery-twinkle-cap-and-idle-park`: Battery: cap twinkle-only rendering at 30 Hz and park the rAF loop when nothing changes

*performance · impact 3→3 · effort S→S · verdict **revise***

**Pitch.** Leaving the sky view open on a laptop or phone stops burning the GPU at full refresh rate for star twinkle nobody can tell apart at 30 Hz. The page drops to near-zero wakeups when paused.

**Current state.** Sky view on High, paused, rendered 164 frames/s continuously in my measurement: full HDR+MSAA+bloom frames, forever. The only reason is `twinkle` in the `continuous` test (js/app/loop.js:310-312; uTwinkle at js/render/sky.js:516-517). Orbit view, paused, renders 0 frames/s, which is good. But frame() always re-arms requestAnimationFrame (loop.js:390), so the clock tick, rig.update/OrbitControls and the store reads run at every vsync (60-144 Hz) even when idle. The JS cost is small (about 1% of the main thread in a 5.4 s idle profile), but it keeps the browser's frame pipeline awake.

**Proposal.** 1) In loop.js, split `continuous` into motionContinuous (camera, tween, fast clock, intro, pointer) and ambientContinuous (twinkle, Live 1x pulses). When only the ambient one is true, render if now - lastRenderAt >= 33 ms (30 Hz, or 24 Hz on coarse). Optionally fade twinkle out after 120 s without input and resume it on any input. 2) Park the loop when nothing is dirty or continuous. Compute nextWakeMs: the readout is due in FULL_INTERVAL_MS at Live 1x, the frame snapshot is stale in SNAP_STALE_MS, Infinity when paused. Use setTimeout(resumeRaf, nextWakeMs) instead of rAF. Re-arm rAF immediately from invalidate(), the store subscription (loop.js:160-168), clock.onChange, pointerdown/wheel (loop.js:395-397), rig.onInteract, ResizeObserver and visibilitychange. 3) This depends on the governor fix: a deliberately throttled 30 Hz cadence must not read as slowness. Feed the governor only from motionContinuous frames.

**Risks.** Missing a wake source shows up as a stale frame. Mitigate by funnelling every wake through loop.invalidate() and adding a unit test with a fake rAF/timer that asserts 0 rAF callbacks while paused and idle. OrbitControls damping must still finish (rig.update returns moving=true until settled). Reduced-motion users are unaffected (no twinkle). Size: nothing.

**Files.** `js/app/loop.js`, `js/render/sky.js`, `test/app.loop.test.mjs`

**Verifier evidence.** Measured on the real GPU, paused, 3 s windows. Sky view on High at night: 164 frames/s. Sky view on High in DAYTIME (HCMC, Sun 63.5° up, stars invisible): 163 frames/s. Sky view on Medium: 0. Orbit on High: 0. The cause is loop.js:310-312: `twinkle` makes rendering continuous whenever cfg.twinkle && skyBlend > 0.5, regardless of whether any star is visible. sky.js:516-518 only animates uTwinkle and uTime. frame() always re-arms rAF (loop.js:390).

**Verifier corrections.** 1) Biggest and cheapest fix: only count twinkle as continuous when stars are actually visible, for example exposure.stars (or the sky module's starExp) above a small threshold. Daytime sky view on High then drops from about 160 fps to 0. 2) Cap twinkle-only frames at about 30 Hz as proposed. 3) The claimed dependency on the governor fix is moot: sample() only runs when the previous tick also rendered (renderedLastFrame, loop.js:370-381), so a throttled ambient cadence produces no governor samples at all. 4) Parking the rAF loop on setTimeout is optional. It saves little (about 1% of the main thread) and risks stale frames, so do it last, if at all.

### `low-tier-texture-diet`: Texture diet: the Low tier's '2K' day map is larger than the 4K one; ship a 2K night map, re-encode, and add WebP variants

*performance · impact 4→3 · effort M→M · verdict **revise***

**Pitch.** The tier meant for weak phones and Save-Data users downloads about 35% less, uses about 32 MB less GPU memory, and looks consistent with the higher tiers. Every tier sheds 25-30% of its texture bytes.

**Current state.** check-size reports low 3.71/3.80 MB raw (1.90 MB on the wire), medium 4.19/4.30, high 5.24/5.40. Textures make up most of the wire bytes (high: 2.67 of 3.44 MB). Measured JPEG headers: earth_atmos_2048.jpg (low's day2k, js/render/textures.js:24) is 512,606 B at 1.96 bits/px, 4:4:4, about q97. It is bigger than earth_day_4096.jpg (473 KB at 0.45 bits/px), and it is a different source image, so low and medium differ in colour. Low still loads the 4096x2048 night map (keysForTier always lists 'night', textures.js:90): about 44.7 MB of VRAM with mips on the weakest devices. moon_1024.jpg is 3.63 bits/px (238 KB). earth_clouds_1024.png is a 226 KB palette PNG of a grey field. earth_specular_2048.jpg stores a 1-channel mask in 3 channels. The 1.5 MB brc4k map packs bump/roughness/clouds into R/G/B but is 4:2:0 subsampled. YCbCr chroma subsampling blends the channels, so cloud edges bleed into the roughness/bump data (an accuracy defect inherited from the three.js example asset).

**Proposal.** scripts/build-textures.mjs, zero npm dependencies: drive headless Chrome (scripts/lib/chrome.mjs) to decode each source and export via canvas.toBlob('image/jpeg'|'image/webp', q) with a high-quality resize. Commit the outputs with sha256 recorded as derived assets. CI runs --check against the hashes, not a re-encode, because encoder output varies across Chrome versions. Outputs: day2k derived from day4k (q82, about 160 KB), a new 'night2k' key (about 80 KB) chosen in keysForTier when dayTex==='day2k', moon at q85 (about 70 KB), clouds1k as a grey JPEG (about 50 KB), specular as a grey JPEG. For brc4k, either encode 4:4:4 or split into a 4K grey cloud map plus a 2K bump/roughness map. Then WebP twins for all maps, chosen in textures.js by a one-time canvas.toDataURL('image/webp') probe (Safari 14+ and every evergreen browser supports it), falling back to JPEG. Expected: low wire 1.90 -> about 1.25 MB, high texture wire -25-30%. Staging grows by the WebP twins (+1.5 MB, still 8 of the 12 MB budget). Update FALLBACK_ASSETS and the readAssets regex in scripts/check-size.mjs, and lower TIER_BUDGETS afterwards so the gain is locked in.

**Risks.** Licences: the day/night maps are CC-BY-4.0 (Solar System Scope), and derivatives keep that attribution. earth_atmos_2048 has 'no separate licence stated', so deriving the 2K from the CC-BY 4K map also cleans up provenance. WebP decode through createImageBitmap is fine; keep the <img> fallback path (textures.js:204-213). Visual QA: q82 on the day map near coastlines. Test with the regression-gates golden scenes.

**Files.** `js/render/textures.js`, `scripts/build-textures.mjs`, `scripts/check-size.mjs`, `vendor/VENDOR.json`, `THIRD_PARTY_NOTICES.md`, `assets/textures/`

**Verifier evidence.** Parsed JPEG headers. earth_atmos_2048.jpg (day2k): 512,606 B, 4:4:4, 1.96 bpp, luma quant table starting 2,2,2,3 (about q95). earth_day_4096.jpg: 473,093 B at 0.45 bpp. earth_night_4096.jpg: 267 KB at 0.25 bpp. moon_1024.jpg: 3.63 bpp (238 KB). brc4k and specular are 4:2:0. check-size: low 3.71/3.80, medium 4.19/4.30, high 5.24/5.40 MB, staged 6.53/12 MB. keysForTier always adds the 4096 'night' map (textures.js:90). VENDOR.json shows day2k is a different source ('no separate licence stated'). The earth shader compensates with uDayGain ('the 2k map is darker', earth.glsl.js:104).

**Verifier corrections.** 1) clouds1k is a palette PNG with tRNS, and the shader reads density from ALPHA ('clouds1k: alpha carries density', earth.glsl.js:36). A grey JPEG needs a shader change (uCloudMode 1 reads .r). 2) Deriving day2k from day4k means retuning or removing uDayGain. 3) Re-encoded files can no longer sit in VENDOR.json with upstream hashes, or `fetch-vendor --check` fails in CI. Give them a separate derived-assets manifest. 4) A canvas.toDataURL('image/webp') probe tests ENCODE support: Safari 14-15 decodes WebP but cannot encode it. Probe decode instead, with createImageBitmap or img.decode() on a tiny WebP. 5) Highest value per effort: moon q85 (all tiers, about -160 KB), a 2K night map for low and coarse, and day2k from day4k. The WebP twins double the asset matrix for about 25% more savings and can come later.

### `boot-critical-path-diet`: Boot diet: remove about 0.6 s of main-thread blocking behind the loader (GL probe, a 399 ms upload, shader-error readbacks, per-chunk redraws)

*performance · impact 3→2 · effort S→S · verdict **revise***

**Pitch.** The loader animation stops stuttering, and the first globe frame arrives several hundred ms sooner on every device. These are four small, independent changes with measured payoffs.

**Current state.** Real-GPU boot (desktop, localhost) had long tasks of 164, 184, 427 and 128 ms. Instrumenting WebGL2RenderingContext.prototype showed where they go. The inline probe's getContext('webgl2') takes 160 ms (index.html:279), then is thrown away (loseContext, index.html:289-290). three's own context takes another 99 ms (js/render/context.js:76). A single texSubImage2D of the 4096x2048 day map blocked for 399 ms inside renderer.initTexture (js/render/textures.js:252); the next 4K upload took 23 ms. three's default debug.checkShaderErrors=true issues 26 synchronous getProgramInfoLog calls (89 ms) that stall on the GPU process and partly defeat compileAsync / KHR_parallel_shader_compile (context.js:270-289). Every streamed network chunk calls onProgress, and main.js answers each with loop.invalidate() (js/main.js:709-716, textures.js:187-190). That is a full composer render per 16-64 KB chunk, including after the loader is gone when the progress bar is invisible.

**Proposal.** 1) context.js: renderer.debug.checkShaderErrors = isDev, where isDev is localhost, `#debug=1` or webdriver, so CI and smoke still catch shader errors. 2) Upload pacing in textures.js: queue decoded bitmaps and initTexture at most one large map per rAF (after the frame is submitted), so two 4K uploads never land in the same task. Combine with the previews from instant-earth-progressive-textures so the queue never blocks first paint. The real fix for the 399 ms is GPU-compressed textures (ktx2-gpu-compressed-textures). 3) Reuse the probe context: run the inline probe on #scene with the exact attributes three requests (alpha:true, depth:true, stencil:false, premultipliedAlpha:true, powerPreference:'high-performance', antialias decided from the probe: true only for software or weak GPUs, which become Low), keep it, and pass it as `context` to WebGLRenderer. A tier that later disagrees with the antialias choice simply keeps it. 4) In main.js onProgress, invalidate only on ev.done or ev.error, and update the loader bar only while !readyFlag.

**Risks.** Handing over the probe context requires the probe's attributes to match what three expects; three r170 accepts an external `context`. If the probe ever runs on a non-#scene canvas (old cached HTML), fall back to today's behaviour. checkShaderErrors=false in production hides shader errors on exotic drivers: keep the strike/fallback system and log via the diagnostics bundle (context-loss-backoff-and-diagnostics). No size change. Text mode: the probe is unchanged when there is no WebGL2.

**Files.** `js/render/context.js`, `js/render/textures.js`, `index.html`, `js/main.js`

**Verifier evidence.** Instrumented boot on the real GPU, High tier, twice. Probe getContext('webgl2') took 123-132 ms and three's context 100 ms (confirmed). 26 getProgramInfoLog calls took about 98 ms (confirmed). The first 4K texSubImage2D blocked 370 ms (confirmed), but I then wrapped it with a gl.getError() sync immediately before the upload. The getError took 359-366 ms and the upload itself only 6-33 ms. The same happens on the low tier (362 ms, then 6 ms). Twenty-three linkProgram calls were issued at 480-636 ms and programs reported COMPLETION_STATUS between 555 and 1069 ms. So the 'upload stall' is the main thread waiting for the GPU process to finish compiling the shaders that compileAsync just started. It is not upload cost. Per-chunk invalidate is confirmed at textures.js:187-190 and main.js:709-716.

**Verifier corrections.** Upload pacing will not help: the second and later 4K uploads take 3-25 ms. The real fix is to call renderer.initTexture only after rc.compile() resolves (queue the decoded bitmaps until then), or to upload before the compile starts. That turns the 360 ms long task into idle time so the loader stays smooth. Context reuse: context.js:76-85 requests alpha:false (not alpha:true) with antialias only for low. Reusing the probe context therefore needs either the tier decided in the inline script or accepting antialias:false for low. Expected gain is about 100 ms. checkShaderErrors=false in production may only move part of the 98 ms wait to the first draw, so measure before claiming it. Keep the trivial onProgress fix: invalidate only on done or error.

### `zoom-streamed-8k-earth`: Zoom-streamed 8K Earth: 'virtual texturing lite' that pages in only the visible high-resolution tiles when you fly close ★

*feature · impact 5→3 · effort XL→L · verdict **revise** · tracked under `detail-tiles`*

**Pitch.** Double-click a city and the night side resolves from a 4K blur into crisp city lights. The Nile delta, the Korean peninsula and the Gulf coast become sharp, while the first load and the offline cache stay the size they are today.

**Current state.** One fixed equirectangular map per key: 4096x2048 at most (js/render/textures.js:21-32). At a 1.5 Earth-radius fly-to distance (js/main.js:1092) the 4K texel is about 10 km and visibly soft at DPR 2. The only streaming is whole-file deferral per tier (keysForTier, textures.js:82-91). The staged site is 6.53 of the 12 MB budget (scripts/check-size.mjs:29), so there is about 5 MB of headroom for optional imagery.

**Proposal.** Data: NASA Black Marble 2016 (night lights, public domain) and Blue Marble NG (day, public domain). Cut each into an 8K equirectangular pyramid of 1024x1024 tiles (32 per map) with scripts/build-textures.mjs. Night tiles compress superbly as WebP (mostly black, about 0.6-1 MB for all 32); day tiles about 2-3 MB. Runtime (High tier, and Medium on request): a 4096x4096 'tile cache' texture holding 16 slots of 1024x1024, allocated once and filled with texSubImage2D, at most one tile per frame. A 32-entry indirection table (a Float32 uniform array or a small 8x4 RGBA DataTexture) maps each tile to its slot, or -1. Each frame (cheap, CPU): from the camera distance and the visible lat/lon bounds (rig + earthMatrix), list the needed tiles, fetch the missing ones (same-origin, SW-cached on first view) with an LRU for eviction. Shader (earth.glsl.js): compute the tile index from the equirect UV; if it is resident, sample the cache at slot + fract, otherwise the base 4K map. Blend by distance (detail weight 0 above 2.2 Earth radii) so the transition is invisible. Mips: generate them per tile into the slot's own mip chain (or clamp to LOD 0-3 with textureGrad) to avoid bleeding between slots, and leave a 4-px gutter per tile. Tile cutting with gutters happens offline. All arrays and textures are preallocated, honouring R5.

**Risks.** Budget: tiles must not count toward the per-tier boot budgets (they load only on zoom), but they do count toward the 12 MB staging budget. Start with night tiles only (about 1 MB), which carry the most wow per byte. Offline: tiles never viewed online are absent, and the shader silently falls back to the base map. Imagery alignment differs between NASA sources and the current CC-BY maps, so either replace the base maps with the NASA ones (also simplifying licences) or colour-match. Low tier: disabled. Text mode: no effect. Cutting the source mosaics (86400x43200) needs an offline step with an image tool; commit only the outputs.

**Files.** `js/render/earth.js`, `js/render/shaders/earth.glsl.js`, `js/render/textures.js`, `js/camera/rig.js`, `scripts/build-textures.mjs`, `scripts/check-size.mjs`, `sw.js`, `THIRD_PARTY_NOTICES.md`

**Verifier evidence.** Maps top out at 4096x2048 (textures.js:21-32), about 9.8 km per texel at the equator. The camera can go down to MIN_DIST 1.08 (rig.js:49), and double-click fly-to uses 1.5-2.4 (main.js:1091-1092). Screenshot shots/perfv-cairo-night-1p5.png (High, DPR 2, Nile delta at night) shows the night lights as visibly blocky squares. The visual payoff of more resolution near the surface is real. The staged site is 6.53 of 12 MB.

**Verifier corrections.** A full virtual-texturing atlas is XL and fragile: per-slot mip chains, gutters, and derivative discontinuities at tile borders need textureGrad. The camera's close views are nearly always around one point (the observer or a double-clicked fly-to target), so use a single 'detail inset' instead. Keep one extra 2048² texture with its own mips, one lat/lon rect uniform and a distance blend. When the camera settles below about 2.2 R, fetch the pre-cut tile (or 2x2 tiles composed on a canvas) around the look-at point and swap it in through the existing onReady path. That gives most of the benefit with no indirection table and no atlas bleeding. Start with night lights only (NASA Black Marble, public domain, mostly black, so tiles are small). Day tiles need colour-matching against the CC-BY base map. 8K only halves the blockiness at 1.5 R; if staging allows, a higher-resolution inset is the better trade.

### `ktx2-gpu-compressed-textures`: GPU-compressed textures (KTX2/Basis, vendored from three r170): about 6-8x less VRAM, no upload freezes, fewer context losses on phones ★

*performance · impact 4→2 · effort L→L · verdict **revise***

**Pitch.** Upload freezes disappear, and High-tier memory falls from about 230 MB (VRAM plus retained bitmaps) to about 30 MB. That is the difference between a phone tab that survives backgrounding and one that reloads, and it makes the 8K detail tiles affordable.

**Current state.** Every map is uploaded as uncompressed RGBA8 with generated mips (js/render/textures.js:216-233): each 4096x2048 map is about 44.7 MB of VRAM. High holds three (day, night, brc4k), about 134 MB, plus milkyway (8 MB, no mips) and the moon. Medium on phones holds about 100 MB. The decoded ImageBitmaps are also retained on the CPU so restore() can re-upload them after context loss (textures.js:296-300), about 100 MB more RAM on High. The first 4K upload blocked the main thread for 399 ms in my measurement. This GPU exposes WEBGL_compressed_texture_s3tc, EXT_texture_compression_bptc and rgtc. iOS and modern Android expose ASTC/ETC2.

**Proposal.** Is a transcoder acceptable under the vendoring rules? Yes. Vendor, pinned and with sha256 via scripts/fetch-vendor.mjs and VENDOR.json exactly like the existing three addons: three@0.170.0 examples/jsm/loaders/KTX2Loader.js, utils/WorkerPool.js, libs/ktx-parse.module.js, libs/zstddec.module.js and libs/basis/basis_transcoder.{js,wasm}. The import-map 'three/addons/' prefix already covers the path. The transcoder runs in its own worker, so the main thread never decodes. Encoding happens offline with the basisu CLI (Apache-2.0) in scripts/build-textures.mjs: ETC1S for the colour maps (day, night, moon), UASTC+zstd for brc4k, whose separate channels also fix the JPEG chroma-bleed, and pre-built mips. Commit the .ktx2 outputs with sha256; CI checks hashes only. textures.js: add `ktx2` URLs to ASSETS, try KTX2Loader on Medium/High, and fall back to the current JPEG/WebP path on any failure (no compressed formats, wasm blocked). Keep the compressed bytes for restore() instead of the decoded bitmap. Low tier keeps small JPEG/WebP, so it never downloads the transcoder.

**Risks.** Bytes, honestly: the transcoder is about 0.5 MB raw (roughly 0.2 MB compressed; measure it with check-size). An ETC1S 4K map with mips usually comes out at or above today's very compressed 0.45 bits/px JPEG. Medium (4.19/4.30) and High (5.24/5.40) budgets must be rebaselined or offset by low-tier-texture-diet; the spec's under-6 MB hard line still holds. ETC1S is slightly blockier than JPEG on smooth ocean gradients, so the visual QA belongs in the golden scenes. Workers are created from Blob URLs (fine on GitHub Pages; a future CSP would need worker-src blob: and 'wasm-unsafe-eval'). This is pure render-layer work, with no purity concerns.

**Files.** `js/render/textures.js`, `scripts/fetch-vendor.mjs`, `vendor/VENDOR.json`, `scripts/build-textures.mjs`, `scripts/check-size.mjs`, `THIRD_PARTY_NOTICES.md`, `test/repo.vendor.test.mjs`

**Verifier evidence.** No KTX2/Basis code or vendored loader exists (vendor/three/addons has only controls, postprocessing, Sky and shaders). VRAM arithmetic is right: 4096x2048 RGBA8 with mips is about 44.7 MB, and High holds day4k, night and brc4k. The decoded ImageBitmaps are retained for restore() (textures.js:296-300). But the central pitch, 'upload freezes disappear', is refuted. Measured: the first 4K upload's 360 ms block is a GPU-process sync wait for shader compilation (getError before the upload took 359-366 ms; the upload itself 6-33 ms). Later 4K uploads take 3-25 ms. Compressed uploads would hit the same sync point.

**Verifier corrections.** Drop the freeze claim. The remaining benefit is memory, which matters only if field data shows phones losing the context. The costs are significant: about 0.5 MB raw of transcoder, ETC1S maps at or above today's 0.45 bpp JPEG, and UASTC+zstd for the 4K brc map likely several MB, which breaks the 5.40 MB High budget. ETC1S also shows blocking on ocean gradients, plus an external basisu build step. Cheaper memory wins first: (a) after upload, close the retained ImageBitmaps and on context restore re-fetch from the HTTP/SW cache (about 100 MB RAM back on High); (b) use 2K night and day maps on low and coarse medium (see low-tier-texture-diet). Revisit KTX2 only for coarse medium if context-loss diagnostics show a need.

### `sw-atomic-updates-offline-ci`: Service worker 2.0: content-hashed versions, atomic precache, a 'new version ready' toast, and an offline-reload smoke test in CI

*engineering · impact 4→3 · effort M→M · verdict **revise***

**Pitch.** The 'works offline' promise becomes something CI proves on every push. Returning visitors get updates atomically, announced with a polite toast, instead of mixed old and new files or stale data that never updates.

**Current state.** VERSION is bumped by hand (sw.js:9-11, 17), and vendor/, assets/ and data/ are cache-first (sw.js:116). One forgotten bump means returning visitors keep the old sky.json and textures until some later bump. Install calls skipWaiting (sw.js:93), and activate deletes the old caches and claims open pages (sw.js:99-102). A page that is open across a deploy then pulls new-version files into old-version code for anything it loads lazily: the debug overlay (js/main.js:1233), the astro worker or its main-thread fallback (js/astro/client.js:115), and tier-switch textures (main.js:1153). The precache list is just this visit's performance resource entries (main.js:1329), so other tiers' textures are missing offline. Pinning High in Settings while offline gives the flat placeholder plus a toast. Registration is skipped unless protocol is https (main.js:1323), so localhost and the CI smoke never run the worker at all. Separately, context-loss restore was tested OK manually, but nothing in CI covers it either.

**Proposal.** 1) scripts/stage-site.mjs (deploy-time only; dev is unchanged): write _site/sw-manifest.json {version: sha256 over every shipped file, files:[path, sha]} and stamp that version into _site/sw.js. Keep the existing test that dev VERSION equals js/version.js and package.json. 2) sw.js: on install, precache the shell, the boot module graph and the astro worker graph (listed in the manifest by the same modgraph crawl check-size uses), sky.json and cities.json, all at that version. Textures stay lazy, but are cached for every key the app requests. No skipWaiting: post {type:'update-ready'} to clients. The UI shows a toast ('A new version is ready · Reload') through the existing ui/toast.js, and its button sends {type:'skip-waiting'}. Delete old caches only after activation. 3) main.js: register when isSecureContext (localhost counts) and `#sw=1` or on production, and expose __app.sw = {version, controlled}. 4) Smoke: a new --offline-reload flag. Load and wait for navigator.serviceWorker.controller and a 'precached' message, then Network.emulateNetworkConditions {offline:true} and reload. Assert ready, events received (bus 'events'), no failed local requests, and textures from the cache. Add it as a fourth CI step. Also add a --context-loss step: loseContext, then restore, then assert frames resume (and, after the context-loss fix, no WebGL warnings).

**Risks.** Stamping VERSION at deploy time is a small build-like step, but only in the Pages workflow, which already stages files; the repo itself stays no-build. Precaching the full graph raises first-visit background bytes by the modules this visit did not load, roughly the other tiers' textures if those are included, so keep textures lazy. The sw.js scope logic (sw.js:20-29) already handles the /planet-location-marker/ sub-path; test it with --subpath.

**Files.** `sw.js`, `js/main.js`, `scripts/stage-site.mjs`, `scripts/smoke.mjs`, `.github/workflows/ci.yml`, `js/ui/toast.js`, `test/repo.assets.test.mjs`

**Verifier evidence.** Verified. VERSION is hand-bumped (sw.js:17), and repo.assets.test.mjs:26-30 only checks equality. vendor, assets and data are cache-first (sw.js:116); js and css are stale-while-revalidate (sw.js:117). skipWaiting is at sw.js:93, and activate deletes and claims at sw.js:97-103. The precache list is this visit's performance resource entries (main.js:1329). Registration is gated on https (main.js:1323), so smoke and CI never run the worker. pages.yml already runs stage-site.mjs, so a deploy-time stamp fits.

**Verifier corrections.** With atomic versions, js/ and css/ must also become cache-first within a version, precached from the manifest. Today's stale-while-revalidate writes whatever the network has into the CURRENT version's cache, so after a deploy the old worker fills its cache with new-version modules, and the next load mixes versions even without skipWaiting. Register on isSecureContext (127.0.0.1 counts) behind #sw=1 for smoke. Otherwise the plan is sound, including the offline-reload smoke step.

### `regression-gates-ci`: Visual-regression goldens and performance budgets in CI, using the zero-dependency PNG decoder the repo already has

*engineering · impact 3→3 · effort M→M · verdict **keep***

**Pitch.** Every pull request is checked against golden renders (globe, eclipse totality, dusk sky, mobile, low tier) and against hard performance budgets. Visual polish and the measured wins above stop silently regressing.

**Current state.** CI runs three smoke passes and uploads the screenshots as artifacts, but compares nothing (.github/workflows/ci.yml:44-69). There are no timing assertions. The governor is off under webdriver (js/main.js:841). check-size covers bytes, not jank. The repo already has decodePng/encodePng (scripts/lib/png.mjs:99, 155) and a CDP client (scripts/lib/chrome.mjs). Context restore emits 50 'WebGL: INVALID_OPERATION: delete: object does not belong to this context' warnings (measured), and nothing flags them.

**Proposal.** scripts/golden.mjs. A fixed matrix of hash URLs with t=…&p=0&intro=0, reduced motion (no twinkle, deterministic), SwiftShader (deterministic per Chrome version), 1440x900 and 390x844@3: globe HCMC night, eclipse 2027-08-02 Luxor globe and sky view, Paris sunset sky view, q=low, text mode (--no-webgl). Decode with decodePng and compare per pixel (luma delta above 6/255) against test/golden/*.png. Fail if more than 0.5% of pixels change, and write a diff heat-map PNG as an artifact. Add --update to rewrite the goldens. Run the perf gates from an --init shim like the one used for these measurements (wrapping WebGL2RenderingContext.prototype and observing long-animation-frame entries). Gates: programs at most 32/23, draw calls at most 31/16, total texSubImage2D under N ms, zero getBoundingClientRect calls inside rAF during a 3 s time-lapse, 0 frames rendered in 3 s paused in orbit, at most 32 frames/s paused in sky view (after the battery idea), the longest boot LoAF under a threshold, and zero WebGL warnings across a loseContext/restoreContext cycle. Pin the Chrome version in CI (browser-actions/setup-chrome with a fixed version) so the goldens stay stable.

**Risks.** SwiftShader output can shift across Chrome releases, so pin the version and give the update path one command. Goldens add about 1-2 MB to the repo but are excluded from the site (stage-site already excludes test/). Timing gates on shared CI runners are noisy, so gate on counts (calls, programs, frames) and keep millisecond thresholds generous.

**Files.** `scripts/golden.mjs`, `scripts/smoke.mjs`, `scripts/lib/png.mjs`, `.github/workflows/ci.yml`, `test/golden/`

**Verifier evidence.** ci.yml runs three smoke passes and uploads the screenshots with no comparison and no timing or count assertions. decodePng and encodePng exist (scripts/lib/png.mjs; I used them to crop shots). The governor is off under webdriver (main.js:841). I reproduced the context-restore warnings: 50 'WebGL: INVALID_OPERATION: delete/deleteVertexArray: object does not belong to this context' after loseContext/restoreContext (shots/perfv-ctxloss.png). Smoke passes with them because it only fails on errors. Count-based gates are measurable now, from my runs: 0 frames/s paused in orbit, 164 frames/s paused in sky view on High.

**Verifier corrections.** Compare the WebGL canvas only: hide #ui-root and #labels-root before the shot. The developer works on Windows while CI is Ubuntu, so DOM text rendering will never match a local golden. Generate and update goldens in CI, for example with a workflow_dispatch job that uploads them as an artifact, not locally. SwiftShader is detected as 'software' and so runs low unless q= is forced, so add q=high scenes explicitly. Gate on counts (programs, draw calls, frames while paused, getBoundingClientRect calls in rAF, WebGL warnings), not milliseconds.

### `mobile-fxaa-final-pass`: Free anti-aliasing on phones: FXAA in the existing final pass when MSAA is off

*visual · impact 3→2 · effort S→S · verdict **revise** · tracked under `mobile-no-aa`*

**Pitch.** The Earth's limb, beams and the compass ring stop stair-stepping on phones, at a cost of a fraction of a millisecond.

**Current state.** On coarse pointers the medium tier sets msaa=0 (js/core/quality.js:111). Composer tiers create the canvas with antialias:false (js/render/context.js:78: only 'low' gets antialias). So phones on Medium render with no anti-aliasing at all, at DPR capped to 1.5 on 3x screens. Jagged staircase edges are visible on the limb in shots/mobile.png (bottom of the globe). FINAL_FRAG (js/render/postfx.js:46-69) is already a full-screen pass that samples tDiffuse.

**Proposal.** Add a compact FXAA 3.11 'console' variant (5 taps: centre plus 4 diagonals on luma, edge-direction blend) at the top of FINAL_FRAG behind #ifdef PC_FXAA. Enable it via material.defines when cfg.msaa === 0 && cfg.composer, set once in createFinalPass and setTier, so nothing changes per frame. Apply it to the HDR input before the vignette, computing luma on clamp(c,0,1) to keep the Sun and beams from dominating the edge metric. The fragment keeps #include <tonemapping_fragment> and <colorspace_fragment> as the rules require. Cost: about 0.2-0.4 ms at 585x1266 on Adreno 6xx-class GPUs. Alternatively, test msaa:2 on coarse devices, since tile-based GPUs resolve cheaply; let the golden mobile scene decide.

**Risks.** FXAA slightly softens star points and label-free text drawn in WebGL. Exclude it in sky view at high star density, or reduce the subpixel term. The DOM labels are unaffected. Low tier is unchanged (it uses native MSAA, no composer). Text mode: none.

**Files.** `js/render/postfx.js`, `js/core/quality.js`, `test/render.shaders.test.mjs`

**Verifier evidence.** Confirmed that coarse medium sets msaa=0 (quality.js:111) and that the context's antialias is fixed at creation for 'low' only (context.js:78). No FXAA exists anywhere. FINAL_FRAG is a full-screen pass (postfx.js:46-69). My real-GPU capture at 390x844@3, q=medium (coarse=true, canvas 585x1266 at DPR 1.5) is shots/perfv-mobile-medium-far.png, with crops in ...-crop-limb.png and ...-crop-const.png. It shows only mild stair-stepping on the limb (the atmosphere glow masks most of it) and on thin lines. The compositor's 2x bilinear upscale softens the rest. The visible payoff is smaller than pitched.

**Verifier corrections.** Compute the edge luma on a tone-mapped approximation (c/(1+c)) rather than clamp(c,0,1), so bright beams and the Sun don't saturate the metric. A related gap: any runtime downgrade to low (governor or Settings) keeps the antialias:false context created at boot, so low-after-downgrade has no AA at all. Low has no composer, so this FXAA cannot cover it; consider keeping the final pass on low after a runtime downgrade. Cheap to do, but low impact.

### `context-loss-backoff-and-diagnostics`: Memory-pressure-aware context-loss recovery, warning-free restore, and a 'Copy diagnostics' button

*engineering · impact 3→2 · effort S→S · verdict **keep***

**Pitch.** On phones that keep losing the GPU, the app steps down a tier and stays up instead of looping through 'Graphics were reset'. When something does break, a user can paste one JSON blob into an issue instead of 'it's blank'.

**Current state.** onRestored rebuilds at the same tier with the same textures (js/render/context.js:336-348, js/main.js:994-1003). If the loss came from GPU memory pressure (iOS backgrounding, Android OOM), the same footprint is likely to be lost again. During a manual loseContext/restoreContext test, the restore logged 50 WebGL INVALID_OPERATION warnings ('delete: object does not belong to this context'). The cause is postfx.dispose() deleting GL objects from the dead context (context.js:339-342). Errors are collected in window.__pcErrors (index.html:115-116), and the loop counts strikes (js/app/loop.js:195-200), but after boot none of this is visible to users. detectTier even returns a `reason` (js/core/quality.js:75) that nobody surfaces.

**Proposal.** 1) After a context loss, drop the composer and its targets without calling dispose() (just null them; their GL objects died with the context), then build fresh ones. That removes the warnings. 2) Keep a sliding window of losses. A second loss within 60 s pins one tier lower for the session (governor.pin plus applyTierCfg), with the toast 'Reduced graphics detail to keep things stable'. A third loss falls back to text mode with a Retry action. 3) Add a 'Copy diagnostics' button in Settings/About (js/ui/settings.js). It copies JSON of version, tier decision {tier, ceiling, reason}, setting, the renderer string, maxTex, DPR, a governor step log (timestamp, from, to, emaMs), disabled modules and strike counts, context-loss count, the last 20 __pcErrors, stats() and URL-hash state without the location (privacy). Offer a prefilled GitHub 'new issue' link. The About panel already holds external credits links, and it opens only on click: no telemetry endpoint, nothing at boot.

**Risks.** The external-URLs rule allows only the geocoder and the About credits, so place the issue link in About (or have the test allowlist it explicitly). Keep the observer coordinates out of the blob by default. Automated coverage for the restore path comes from the --context-loss smoke step in sw-atomic-updates-offline-ci.

**Files.** `js/render/context.js`, `js/main.js`, `js/app/loop.js`, `js/ui/settings.js`, `js/ui/about.js`, `js/core/quality.js`

**Verifier evidence.** Reproduced on the real GPU, High tier. WEBGL_lose_context loseContext, then restoreContext: rendering resumed (36 frames after restore), but 50 warnings were logged, 'delete: object does not belong to this context' and 'deleteVertexArray: ...'. onRestored calls postfx.dispose() on GL objects from the dead context (context.js:336-343). three's dispose listeners still point at the pre-restore WebGLTextures/bindingStates closures. The restore path rebuilds at the same tier (main.js:994-1003). detectTier's `reason` (quality.js:75) is never surfaced, and __pcErrors (index.html:115-116) is invisible after boot.

**Verifier corrections.** Nulling the composer instead of disposing it is right; also null the bloom and final passes and their full-screen-quad geometry, which cause the deleteVertexArray warnings. REPO_URL already exists in js/version.js, so the prefilled issue link can be built from it inside About. On iOS a lost context often never restores (the page reloads), so record the loss count in sessionStorage and apply the tier step on the next boot as well.

### `hitch-free-tier-switch`: Hitch-free tier switches: compile the next tier's shader variants and upload its textures before swapping

*performance · impact 2→3 · effort M→M · verdict **keep***

**Pitch.** When the governor steps down, which it does exactly because frames are already slow, the user sees no multi-hundred-millisecond freeze on top. It also makes a governor that can step up safe.

**Current state.** applyTierCfg (js/main.js:1138-1159) calls rc.setTier, which can rebuild the composer and re-allocate the MSAA target (js/render/postfx.js:253-277). It then broadcasts setQuality: earth rebuilds both sphere geometries and swaps material.defines with needsUpdate=true (js/render/earth.js:346-362), and atmosphere does the same (js/render/atmosphere.js:121). The tier's textures load at the same moment (main.js:1153). The next rendered frame therefore pays a synchronous shader compile and link plus any 4K upload, during a period the governor had already judged too slow. rc.compile() only warms the current tier's variants (context.js:270-289).

**Proposal.** Make the switch two-phase in main.js: prepareTier(cfg) followed by commitTier(cfg). Prepare: modules that change defines expose `prepareQuality(cfg)`, returning lightweight clone materials (material.clone() with the new defines) attached to a hidden staging Scene of tiny meshes (allocated once, reused). Then run renderer.compileAsync(stagingScene, camera, targetScene), which uses KHR_parallel_shader_compile (exposed on this machine) to compile off the critical path. New textures go through the paced upload queue (boot-critical-path-diet), and geometry for the new segment counts is built in the same idle slice. Commit, on the next frame: swap materials, geometries and composer config in one go. Under pressure, a governor downgrade can first apply the cheap parts immediately (DPR cap, bloom off) and defer the shader-variant parts to commit. Unit-test the sequencing with fake modules.

**Risks.** Clone materials must share uniforms objects so state stays in sync. Dispose the clones after commit to avoid leaks; the smoke memory-stability check will catch mistakes. Without KHR_parallel_shader_compile (some mobile browsers), compileAsync still compiles synchronously, but at least away from the frame that already proved slow. Never allocate in the per-frame path; staging happens only on tier events.

**Files.** `js/main.js`, `js/render/earth.js`, `js/render/atmosphere.js`, `js/render/context.js`, `js/render/postfx.js`

**Verifier evidence.** Measured with a LoAF observer on the real GPU via actions.setQuality. High to medium produced one 495 ms long animation frame. Medium to low produced 1820 ms, because low drops the composer, so every material recompiles for direct-to-canvas output and the low textures load. Low to high produced none, since the high variants were still cached from boot. applyTierCfg (main.js:1138-1159) calls rc.setTier, then broadcast setQuality, then texture loads, all synchronously before the next render. rc.compile() exists (context.js:270-289) but is used only at boot. Because governor steps happen exactly when frames are already slow, these freezes land at the worst moment.

**Verifier corrections.** Simpler than staging clone materials: apply the new defines (needsUpdate), call loop.setRenderPaused(true), and await renderer.compileAsync against the NEXT target (setRenderTarget(null) for low, the new composer input otherwise), using KHR_parallel_shader_compile. Defer the DPR and composer change (rc.setTier) until after it resolves, because a drawing-buffer resize clears the canvas and presentIfCleared would force a synchronous render. Then commit and unpause. Also defer initTexture of new-tier maps until after the compile (see boot-critical-path-diet). Effort M is fair.

## Lens: Astronomy content & new features

The astronomy core is accurate and well tested. Snapshot, almanac and events wrap Astronomy Engine carefully. But the content stops at the nine BODIES and a magnitude-6 star list, and many ready-made Astronomy Engine 2.1.19 APIs go unused: JupiterMoons, SearchTransit, SearchPeakMagnitude, SearchLunarApsis, SearchSunLongitude, Libration, DefineStar, and Illumination().ring_tilt, which is computed and then thrown away. Zooming the sky view to its 5° minimum shows nothing new. Jupiter is the same 12 px glyph with no moons, and the field holds about three stars. The globe also never shows where an eclipse goes; only the point of greatest eclipse is kept. The biggest opportunity is to turn the app's accurate geometry into a few signature moments: the 258 km path of totality drawn across the globe (prototyped below, it matches NASA's published values), an eyepiece view where planets resolve into phased discs with Saturn's rings and Jupiter's moons, and meteor showers and historic comets that use the 1000–3000 time range. There are also two precise defects: the equatorial grid stays in the J2000 frame (5.2–5.5° off the true pole at the ends of the range), and eclipse visibility is judged from a single instant.

### `eclipse-path-of-totality`: Path of totality on the globe, with cities in the path and 'move me into the path' ★

*feature · impact 5→4 · effort L→L · verdict **keep***

**Pitch.** Jump to the 2 Aug 2027 eclipse and a glowing 258 km ribbon runs from the Atlantic through Gibraltar, Luxor and Jeddah to the Indian Ocean, with time ticks along it. A live dot shows where the umbra is right now. The panel lists 'Luxor 6 m 25 s · Aswan · Jeddah…', and one click puts you on the centre line.

**Current state.** events.js:233-249 keeps only ge.latitude/longitude (the point of greatest eclipse). actions.js:181-198 shadowPoint() computes the instantaneous axis–sphere hit, but only to aim the camera (actions.js:571-575). The Earth shader dims each fragment for the current instant only (earth.glsl.js:181-187), so the track appears only as a moving dark spot (see astro-eclipse-globe-noclutter.png). At the default framing the pin rings hide even that (eclipse-luxor.png). Nothing says where totality goes or for how long.

**Proposal.** 1) New pure module js/astro/eclipse-path.js: eclipsePath(peakMs) → {centre, north, south: Float32Array[lat,lon,dtSec]…, widthKm, kind}. Algorithm: step from first to last axis contact every 20 s, refining both ends by bisection. At each step take GeoMoon and GeoVector('Sun', t, true) rotated to EQD (Rotation_EQJ_EQD), with axis â = norm(M−S). Intersect M+τâ with the WGS84 ellipsoid (scale z by 1/(1−f), take the near root). Rotate by GAST to geodetic lat/lon. Umbra radius rU = R☾ − τ·(R☉−R☾)/|S−M|; a negative value means annular. For the N/S limits, offset the axis ±|rU| in the fundamental plane, perpendicular to the ground-track direction, and re-intersect. Duration on the centre line ≈ 2|rU|/v_ground. I prototyped this in scratch for 2027-08-02. It gives greatest point 25.49°N 33.19°E and umbra radius 129 km (width 258 km), matching NASA's 25.5°N 33.2°E and 258 km. Move shadowPoint() here from js/app so the code stays pure. 2) Worker op 'eclipsePath' in worker.js OPS (transferable arrays, ~10 ms). 3) New js/render/eclipse-path.js, a RenderModule registered in main.js importRenderStack/create. It draws a triangle-strip ribbon between the limits at r=1.0015 as a child of the Earth transform (Earth-fixed), plus a thin centre line and ticks every 10 min (labels through labels-feed). A pulsing dot sits at shadowPoint(snap) each frame (it only moves an existing mesh). Geometry is built once per eclipse, never per frame. Colours: gold for total, amber and dashed for annular. The low tier gets no glow or ticks. 4) Cities in the path: filter cities.json rows within half-width of the centre polyline, then run AE.SearchLocalSolarEclipse per candidate (measured 1.4 ms each, in the worker) and show the top 12 by totality duration in the event card. A 'Stand in the path' action calls setObserver with the nearest centre-line point. 5) Add a 'Show path' button on solar-eclipse events (events-panel.js) and a layer code in url-state LAYER_CODES. Tests: greatest point and width against NASA's Five Millennium Canon for 3 eclipses. Text mode: the city/duration table is plain DOM and still works.

**Risks.** About 8–10 KB of new JS, counted in every tier through the module crawler (low-tier headroom is 90 KB). The ribbon sits on the unit sphere at geodetic latitude, like the pin: ≤21 km off the ellipsoid, well under the ribbon width. Near the sunrise/sunset ends the ground speed diverges, so the end refinement is needed. Before 1800 the ΔT uncertainty shifts the track in longitude (already covered by the Reduced-accuracy badge). Partial-only eclipses (axis misses Earth) show no ribbon, only a note.

**Files.** `js/astro/eclipse-path.js`, `js/astro/worker.js`, `js/app/actions.js`, `js/render/eclipse-path.js`, `js/main.js`, `js/ui/events-panel.js`, `js/core/url-state.js`, `test/astro.eclipse-path.test.mjs`, `docs/ASTRONOMY.md`

**Verifier evidence.** Nothing like it exists. grep finds no path, track or ribbon code. The 'footprint' layer (layers.js:39, earth.js:338-369) shows where the selected body is up, not an eclipse track. events.js:233-249 keeps only ge.latitude and ge.longitude. actions.js:181-198 shadowPoint() is used only by jumpToEvent (actions.js:571-575). earth.glsl.js:181-187 dims fragments only for the current instant. astro-eclipse-globe-noclutter.png shows the moving dark spot, and eclipse-luxor.png confirms that the pin rings and beams cover it at Luxor. I ran AE: SearchGlobalSolarEclipse for 2027-08-02 gives peak 10:06:34Z at 25.49N 33.19E, matching the prototype. Size: low tier measures 3.71 of 3.80 MB (check-size.mjs), so the headroom is about 90 KB.

**Verifier corrections.** (1) The ribbon at r=1.0015 sits under the cloud shell (earth.js:18 CLOUD_RADIUS = 1.006), so medium and high clouds would hide it. Draw it above the clouds (r ≥ 1.007, depth-tested against the Earth only) or with a renderOrder after the clouds. (2) Expect the module to be bigger than 8–10 KB in this repo's heavily commented style: events.js is 19 KB for 453 lines. Plan for about 15–20 KB across the pure, render and UI parts. That still fits, but it competes with the other proposals for the 90 KB low-tier headroom. (3) For durations on the centre line and for cities, take AE.SearchLocalSolarEclipse total_begin/total_end directly instead of 2|rU|/v_ground. That keeps them consistent with the event card (Luxor gives 384.7 s from AE). (4) Moving shadowPoint into js/astro is right; ASTRONOMY.md:280 documents it in js/app/actions.js and needs updating.

### `eyepiece-mode`: Eyepiece mode: planets resolve into true phased discs, Saturn's rings at the real tilt, Jupiter's four moons ★

*feature · impact 5→4 · effort L→XL · verdict **revise** · tracked under `telescope-zoom`*

**Pitch.** Select Jupiter, press 'Telescope', and the sky view zooms to a 0.5° circular eyepiece field. Jupiter becomes a banded, oblate disc with Io, Europa, Ganymede and Callisto lined up beside it, exactly where they are tonight. Saturn shows its rings at today's 6.5° tilt, and Venus is a crescent. Every planet's phase and orientation comes from the real geometry.

**Current state.** rig.js:42 and url-state.js:30 clamp the sky FOV at 5°. Planets are constant-size instanced glyphs: bodies.js:89-92 (glyphSizePx clamps 3–12 px by magnitude only) and bodies.glsl.js:82-110 (a flat disc plus halo, with no phase, rings or moons). At 5° Jupiter is still the same glyph and the field is empty, because the star limit is 6.5 (quality.js:37). See astro-jupiter-fov5.png. snapshot.js:269-273 calls AE.Illumination but drops ring_tilt. AE.JupiterMoons and RotationAxis for the planets are unused.

**Proposal.** 1) Lower SKY_FOV_MIN to 0.2° (rig.js:42, url-state.js:30 CAM.fovMin). At 0.2° and 900 px the scale is 0.8″/px. GPU float32 unit vectors resolve about 0.01″ (ASTRONOMY.md §8), so precision holds. 2) In bodies.js, when angDiamArcsec·pxPerArcsec > 4 px, cross-fade each planet's glyph into a disc impostor: one quad at infinity, with a ray–oblate-spheroid intersection in the fragment shader. Flattening: Jupiter 0.065, Saturn 0.098. The pole comes from AE.RotationAxis(body).ra/dec, converted with raDecToScene. Lighting is Lommel–Seeliger from the true Sun→planet direction (HelioVector), so Venus and Mercury crescents and Mars's gibbous phase come out for free, as the Moon's already do. Surfaces are procedural, with no textures: Jupiter and Saturn latitude bands as a 1D palette plus low-amplitude noise, and Mars polar caps plus albedo tint. Saturn's rings use ray–plane intersection with the ring plane (normal = pole) and an analytic radial optical-depth profile: C ring 74,658–92,000 km, B ring to 117,580 km, Cassini division to 122,170 km, A ring to 136,775 km, plus the Encke gap. Phase 2 adds the globe's shadow on the rings and the rings' shadow on the globe (two extra ray tests). The ring tilt is checked in tests against AE.Illumination('Saturn').ring_tilt, which I measured at 6.51° now, 26.5° in 2032 and −1.2° (edge-on) in 2039. 3) Galilean moons: once per frame, call AE.JupiterMoons(t − lightTime) (measured 0.02 ms) and add the jovicentric offsets to Jupiter's topocentric vector. Draw 4 extra glyph instances at about mag 4.6–5.6. A moon is hidden when behind the disc or inside Jupiter's shadow cylinder (JS test). Phase 2 adds shadow-transit spots, by projecting each moon along −sun onto the impostor sphere. 4) UI: a 'Telescope' action in body-card.js picks a FOV that fits the system (Jupiter: Callisto's orbit about 0.6°; Saturn: 0.15°) and adds a CSS radial-gradient field stop and a '×120' label (no WebGL cost). Beams and labels are hidden below 2° FOV. Low tier: impostor without ring shadows; the moons always show. Optional phase 3: lazily load Tycho-2 tiles to mag 9 so the eyepiece field has real stars.

**Risks.** This is phase 1 (discs, phases, rings, moons). Shadows and the deep-star tiles push it toward XL. Adds about 12–15 KB of JS and shaders to every tier. JupiterMoons uses the L1.2 theory, so its accuracy degrades far from 2000; flag it with the existing Reduced-accuracy badge. The Galilean moons need a light-time-consistent Jupiter vector to avoid arcsecond offsets. Extending the selection model to moons (sel=io) touches the BODIES contract in bodies.js, so keep them as non-selectable extras at first. The camera rig's damping and inertia need retuning at tiny FOVs.

**Files.** `js/camera/rig.js`, `js/core/url-state.js`, `js/render/bodies.js`, `js/render/shaders/bodies.glsl.js`, `js/astro/snapshot.js`, `js/astro/moons.js`, `js/ui/body-card.js`, `test/astro.moons.test.mjs`

**Verifier evidence.** rig.js:42 has SKY_FOV_MIN = 5 and url-state.js:30 has CAM.fovMin 5. The clamp is also applied at rig.js:157 (cam parse) and rig.js:603 (startLook). GLYPH_FRAG (bodies.glsl.js:82-110) draws a constant-size disc and halo. glyphSizePx (bodies.js:94) is magnitude-only, and nothing in js/render reads angDiamArcsec. snapshot.js:269-273 drops ring_tilt. AE 2.1.19 has RotationAxis (astronomy.js:9007) and JupiterMoons (3568); JupiterMoons measured 0.02 ms per call. ring_tilt is 6.54° on 2026-11-03 and is signed, with three ring-plane crossings: 2038-10-21, 2039-04-09 and 2039-07-18. The star limit of 6.5 applies to the high tier only (low 5.0, medium 6.0; quality.js:25-37).

**Verifier corrections.** (1) Blocking issue: the frame snapshot is recomputed only when sim time moves 0.5 s (loop.js:31 SNAP_STALE_MS = 500, loop.js:253). In sky view the whole field therefore steps 7.5″ of diurnal motion twice a second. At 0.2–0.5° FOV (0.5–2″/px) that is a visible 4–15 px jitter. Below about 2° FOV, recompute every frame or interpolate earthMatrix analytically (Rz(ω·dt) about the pole). (2) Lower the clamp in every place: rig.js:42/157/603, url-state CAM and any tests that pin fovMin. Retune the rig's drag gain and damping, which scale with FOV. (3) Procedural Jupiter and Saturn bands will look fake next to the textured Moon. The real payoff is phase, oblateness, the ring ellipse at the true tilt and the four moons, so keep the surfaces nearly flat. (4) Drop phase 3 (Tycho tiles): it breaks offline-first and the size budgets. (5) Re-scope phase 1: moons as extra glyphs, plus a phased oblate impostor and a ring ellipse without shadows. That is about L; the full proposal is XL.

### `meteor-showers`: Meteor showers: radiants, peak events with Moon interference, and live meteors in sky view ★

*feature · impact 5→3 · effort L→L · verdict **revise***

**Pitch.** On Geminids night the sky view shows the radiant in Gemini, and real-rate meteors streak away from it. Pause, and a 'long exposure' composite stacks an hour of streaks into the classic converging-radiant photo. The Events tab says 'Geminids peak Fri 02:00 · ZHR 150 · Moon 22% lit · about 70/h from a dark site here'.

**Current state.** No meteor content exists anywhere in js/. AE.SearchSunLongitude (astronomy.js:4204) is unused. The events SOURCES list (events.js:401-411) has no showers. The frame loop already supports continuous animation in sky view for twinkle (loop.js:310-312), and sky.js exports a reusable instanced line layer at infinity (createLineLayer, used by trails.js:54-59).

**Proposal.** 1) New js/astro/meteors.js (pure) with an inline table of about 12 IMO-calendar showers: {id, name, λ☉peak (J2000), λ window, radiant RA/Dec plus daily drift, ZHR, V∞, population index r, parent}. Examples: Perseids λ140.0°, RA 48 Dec +58, ZHR 100, V59, parent 109P. Geminids λ262.2°, RA 112 Dec +33, ZHR 150, V35, parent Phaethon. Also QUA, LYR, ETA, SDA, ORI, LEO, URS, DRA, CAP and the Taurids. That is under 2 KB. Peak time comes from AE.SearchSunLongitude(λ_date), where λ_date = λ_J2000 + general precession (the streams are fixed relative to the stars). Without that correction the peak is off by up to about 14 days at the ends of the range: an uncorrected λ=140° gives 13 Aug in 1066, while the true value of date is about 127°. 2) Events source meteorShowers(ctx): at the peak, the radiant altitude here (best hour from 22:00 to dawn), Moon illumination and altitude, and expected HR = ZHR·sin(h_rad)·r^(lm−6.5), with lm taken from twilight and Moon phase. Add a 'Meteors' filter chip and icon (events-panel.js:19-30). 3) New js/render/meteors.js: a pool of 64 (low tier: 16) line-layer instances, written in place each frame with no allocation. Each sim-time second is a bucket. Poisson draws come from hash(bucket, k), so the streaks are a pure function of sim time and scrubbing or pausing is deterministic. For each meteor: start point at an angular distance ψ from the radiant, with sky-uniform sampling above 10° altitude; motion along the great circle away from the radiant; length ∝ sin ψ·V; duration 0.2–1 s; magnitude from the r-distribution; head colour by speed. Add a sporadic background of about 10/h. 'Composite' mode keeps the last N sim-minutes of streaks (capacity 256) when paused, or under reduced motion instead of animating. The loop condition gains 'meteors active && skyBlend > 0.5 && !reducedMotion', like twinkle. Also draw a radiant marker and label when the layer is on. Text mode: the events and expected rates still show.

**Risks.** The rendered rates are statistical; label them as illustrative. Outburst years (Leonids 1833 and 1966, Draconids) are not modelled; a small per-year override table could add them. Continuous rendering costs battery, so animate only while a shower is active, in sky view and dark; the low tier gets a small pool and no composite. Adds about 8 KB of JS to every tier. IMO figures are facts; cite the IMO calendar in the About panel.

**Files.** `js/astro/meteors.js`, `js/astro/events.js`, `js/render/meteors.js`, `js/app/loop.js`, `js/main.js`, `js/ui/events-panel.js`, `js/core/url-state.js`, `test/astro.meteors.test.mjs`

**Verifier evidence.** No meteor or shower code exists anywhere in js/ (grep). SearchSunLongitude exists at astronomy.js:4204 and is unused. SOURCES (events.js:401-411) has no showers. Twinkle continuous rendering is at loop.js:310-312 (high tier only). createLineLayer is exported at sky.js:111 and reused by trails.js:54-59. The precession claim checks out: 934 yr × 50.29″/yr = 13.05°, so λ_date = 127° in 1066. AE.SearchSunLongitude works in the equinox of date (SearchSunLongitude(262.2) gives 2026-12-14T04:52Z, the Geminid peak).

**Verifier corrections.** (1) Showers did not exist over the whole 1000–3000 range. The Geminids were first recorded about 1862 and the Quadrantids about 1835. Without per-shower validity years the app will show Geminids over Hastings in 1066. Add validFrom/validTo per shower. (2) True rates are sparse. Geminids at ZHR 150, radiant 60° and lm 6.0 give about 80/h over the whole sky, or about 25–30/h inside a 70° view: one every 2 minutes at 1×, and about 6× fewer under city skies. A streak that is a pure function of sim time lasts only 1–3 frames at 10–60× speed. Use sim time only to seed and count meteors, and play each streak for a fixed 0.3–0.8 s of wall-clock time with the rate scaled by min(rate, cap). Label it illustrative. (3) Make the static long-exposure composite the hero visual. It needs no continuous render loop, so it suits battery, reduced-motion and the low tier. (4) Keep the HR = ZHR·sin h·r^(lm−6.5) event text and the Moon interference; it is the most robust value.

### `eclipse-local-circumstances-and-framing`: Eclipse quick win: contact times, totality duration and a jump that actually frames the eclipse

*ux-polish · impact 4→4 · effort S→S · verdict **keep***

**Pitch.** 'Total solar eclipse visible here' becomes 'Totality 13:01:49–13:08:14 (6 m 25 s), Sun 82° up'. The Jump button lands 20 s before second contact at a 3° field, so you watch the last of the crescent, the corona and Venus pop out, instead of a 7 px dot in a 70° sky.

**Current state.** events.js:261-277 reads only ls.peak.altitude and ls.obscuration. The AE LocalSolarEclipseInfo already carries partial_begin, total_begin, total_end and partial_end with altitudes (astronomy.js:8561-8570), and all of it is dropped. I measured Luxor 2027-08-02 at 385 s of totality, but the app never says so. Jumping into sky view always ends at a 70° FOV: rig.js:512 resets sky.fov to SKY_FOV after the descent, and actions.js:576-581 passes only az/alt. At 70° the eclipse is about 7 px (eclipse-sky.png). At 5° it reads well, with Moon disc, corona and Venus (astro-eclipse-fov5.png). Lunar-eclipse jumps (events.js:226) have the same problem.

**Proposal.** events.js: add contacts {c1, c2, c3, c4} (ms plus altitude) and durationS to local-solar-eclipse events. Rewrite the detail as 'Partial 11:40–14:32; totality 13:01:49–13:08:14 (6 m 25 s); Sun 82° up'. Add the same partial and umbral contact times to lunar eclipses (peak ± sd_partial/sd_total). rig.js: let startToSky's look accept fovDeg (rig.js:446-512) instead of forcing SKY_FOV. actions.js jumpToEvent: for solar eclipses, go to t = c2 − 20 s (or the peak for partials) with fovDeg 3. For lunar eclipses use fovDeg 4. For pairings, fovDeg = clamp(3·sepDeg, 2, 30). timebar.js: tick marks for C1–C4 so the user can scrub through 2nd and 3rd contact. Add a Moon 'A ring of fire for 4 m 12 s' line for annular eclipses. Unit test the Luxor durations against the AE output. Text mode benefits fully.

**Risks.** Very low. The URL hash already round-trips the FOV (cam=s:az,alt,fov). Once FOV ≥ 2° is allowed below the current 5° minimum, this overlaps with eyepiece-mode, but 3° works with today's clamp raised only slightly (or use 5°).

**Files.** `js/astro/events.js`, `js/app/actions.js`, `js/camera/rig.js`, `js/ui/events-panel.js`, `js/ui/timebar.js`, `test/astro.events.test.mjs`

**Verifier evidence.** events.js:261-277 uses only ls.peak.altitude and ls.obscuration. Running AE for Luxor 2027-08-02 gives C2 10:01:49.6Z, C3 10:08:14.3Z, 384.7 s of totality and peak altitude 81.8°, none of which the app shows. rig.js:512 forces sky.fov = SKY_FOV after startToSky. setModeNow (rig.js:934-938) calls startLook without a fovDeg. jumpToEvent (actions.js:576-581) passes only az/alt. startLook already accepts fovDeg (rig.js:592-603), so the plumbing is small. astro-eclipse-fov5.png shows that at 5° the black lunar disc, corona and Venus all read well; the lead's 'no corona' observation is only the 70° FOV.

**Verifier corrections.** (1) Use 5° under the existing clamp; do not lower SKY_FOV_MIN for this. (2) Pass look.fovDeg through setModeNow → startLook when already in sky view. When descending from the globe, chain a startLook FOV tween after startToSky finishes rather than snapping at rig.js:512. (3) Jumping paused to C2 − 20 s leaves a static crescent, because jumpToEvent always calls clock.pause(). Land paused at the peak (mid-totality is the money shot) and add a 'Watch totality' action that sets t = C2 − 30 s and plays at 1–2×. (4) Lunar eclipses: use 4–5° on the Moon and give U1–U4 from peak ± sd_partial and sd_total.

### `comets-halley-1066`: Historic and great comets with physical tails: Halley 1066/1456/1910/1986/2061, Hale–Bopp, NEOWISE ★

*feature · impact 5→3 · effort L→XL · verdict **revise***

**Pitch.** Set the clock to 24 April 1066 over Hastings and Halley's comet hangs in the evening sky with its tail pointing away from the Sun, the 'star' of the Bayeux Tapestry. Then jump to 2061, or to Hale–Bopp's twin tails in 1997. The app's 1000–3000 range spans 13 Halley returns, which makes it a real time machine.

**Current state.** Only the nine BODIES exist (bodies.js:36-46, a frozen contract). Nothing in js/ handles comets, asteroids or Pluto, although AE supports Body.Pluto and offers HelioVector, GravitySimulator and DefineStar (astronomy.js:330, 3593, 9391). The trails module (trails.js:94-131) can already draw a ±N-day apparent path for any direction series.

**Proposal.** 1) New pure js/astro/comets.js: two-body Kepler propagation (elliptic, parabolic and hyperbolic solvers, Newton plus Barker) from per-apparition osculating elements {T, q, e, i, ω, Ω} in the J2000 ecliptic. Rotate to EQJ, take geocentric = helio − AE.HelioVector('Earth'), iterate light time, and map through S. Data (about 2 KB, inline or lazy data/comets.json): Halley per apparition from Yeomans & Kiang (1981, MNRAS 197, 633), giving perihelion times and elements for 1066, 1145 … 1910, 1986 and 2061. Great comets from JPL SBDB (public data): Hale–Bopp, Hyakutake, McNaught, NEOWISE 2020, Swift–Tuttle (1862 and 2126, parent of the Perseids), Great Comet 1811, 1882 Great September. Each entry is valid within about ±1.5 years of its T. Magnitude m = H + 5 log Δ + 2.5 n log r. 2) Rendering, new js/render/comets.js: coma glyph plus two billboards at infinity. The ion tail is straight along the heliocentric radius vector. The dust tail curves in the orbit plane, lagging −v̂. Endpoints come from the true 3D tip (comet + L·r̂ with L ∝ r⁻²) projected from the observer, so foreshortening is right (including Earth passing through Halley's tail in May 1910). Fade with sky exposure like the planets (skyViewExposure). 3) Events: 'Halley's Comet at perihelion' and 'closest to Earth' within the 730-day window. A small 'Famous comets' list in the Events tab jumps to the best date. 4) Selection: add an 'extras' registry (sel=c:halley) separate from BodyId, so the 1–9 keys and beam ordering are untouched.

**Risks.** Accuracy is good only near each tabulated apparition (arcminutes for recent ones, about a degree for medieval Halley because of the T and ΔT uncertainty). Hide comets outside each element set's validity window and show 'approximate'. Tail lengths and brightness are a physically guided model, not a prediction; say so. The elements must be transcribed carefully from the cited sources (cite in THIRD_PARTY_NOTICES). The selection-model extension is the riskiest code change, because many modules index by BODY_INDEX. Adds about 10 KB of JS.

**Files.** `js/astro/comets.js`, `js/render/comets.js`, `js/astro/events.js`, `js/main.js`, `js/ui/events-panel.js`, `js/core/url-state.js`, `test/astro.comets.test.mjs`, `docs/ASTRONOMY.md`

**Verifier evidence.** There is no comet, Halley or Pluto handling in js/ (grep). AE has Body.Pluto (astronomy.js:264), DefineStar (330) and GravitySimulator (9391). The selection model is hard-wired to the nine bodies: url-state.js:329-333 accepts only BODY_IDS, and 8 modules reference BODY_INDEX or isBodyId. trails.js already draws apparent paths.

**Verifier corrections.** (1) The Yeomans & Kiang (1981) per-apparition elements are, as far as I know, referred to the B1950.0 ecliptic and equinox. Check this and rotate them to J2000 before use, or medieval positions will be off by a large fraction of a degree on top of the T uncertainty. (2) Curating about 13 Halley apparitions plus 7 great comets, modelling tails and extending the selection model is XL, not L. (3) Scope phase 1 to Halley only (1066, 1456, 1910, 1986, 2061). Render it as a non-selectable labelled extra with ion and dust tails, plus a 'Famous comets' jump list. Defer the sel=c:… registry. (4) Use the Kepler propagation only, as proposed, without GravitySimulator. (5) Comets are visible only in narrow windows that users rarely visit, so impact is lower than claimed; the 1066 story is the hook.

### `events-breadth-unused-ae`: More real events from unused Astronomy Engine searches: Antares/Pleiades occultations, Venus at greatest brilliancy, transits, perigee, ring-plane crossing

*feature · impact 4→3 · effort S→M · verdict **keep***

**Pitch.** The Events tab gains things observers actually plan around. The Moon occults Antares every month through 2028. Venus reaches greatest brilliancy (−4.9) on 27 Nov 2026, three weeks from today. The 2032 Mercury transit, true perigee supermoons and Saturn's rings going edge-on in 2038–39 also appear.

**Current state.** SOURCES (events.js:401-411) cover phases, oppositions, elongations, eclipses, seasons, planet pairings and Moon–planet appulses. moonAppulses (events.js:381-399) only loops over PAIR_PLANETS (events.js:25), never stars. The supermoon is a fixed 361,900 km threshold (events.js:31). SearchTransit, SearchPeakMagnitude, SearchLunarApsis and SearchPlanetApsis (astronomy.js:8763, 5636, 5780, 5975) are never called. My scan: geocentric Moon–Antares minima are 0.06°–0.47° every month from Nov 2026 to Nov 2027 (an ongoing occultation series), Alcyone 0.65°–1.1° (Pleiades occultations), Regulus 1.05°–1.5°. Venus peak magnitude is 2026-11-27 at −4.87, and the next Mercury transit is 2032-11-13.

**Proposal.** 1) In moonAppulses, treat 5 fixed targets as constant direction tables (Aldebaran, Regulus, Spica, Antares, plus Alcyone for the Pleiades), using J2000 vectors from sky.json. The existing topocentric minimisation and observability gate (events.js:366-379) apply unchanged. The occultation test uses the Moon's semi-diameter as today. 2) peakMagnitude: AE.SearchPeakMagnitude('Venus') gives 'Venus at greatest brilliancy (mag −4.9)'. 3) transits: AE.SearchTransit('Mercury'/'Venus') over the span, plus a local visibility check from the Sun's altitude at start, peak and finish. 4) lunarApsides: SearchLunarApsis gives perigee/apogee with distance, and the supermoon becomes 'full Moon within 24 h of perigee'. 5) Saturn: sign change of Illumination('Saturn').ring_tilt sampled every 10 days gives 'Rings edge-on'. Use SearchPlanetApsis('Mars') to flag perihelic oppositions. Add 'Occultations' and 'Transits' filter chips and icons (events-panel.js:19-30) and timebar colours (timebar.js:79-84). Each source is isolated in try/catch as today. Measure the added worker time for 730 days; it should stay well under 100 ms.

**Risks.** Event spam: monthly Antares passes visible from somewhere must be gated by the existing 'observable here' check, which they are. Fixed-star directions ignore proper motion (negligible for these stars within centuries). Each new search adds worker CPU; keep the events op under its current budget by sampling cheaply.

**Files.** `js/astro/events.js`, `js/ui/events-panel.js`, `js/ui/timebar.js`, `js/ui/icons.js`, `test/astro.events.test.mjs`

**Verifier evidence.** moonAppulses (events.js:381-399) loops only over PAIR_PLANETS (events.js:25). SUPERMOON_KM is fixed at 361,900 km (events.js:31). SearchTransit, SearchPeakMagnitude, SearchLunarApsis and SearchPlanetApsis exist (astronomy.js:8763, 5636, 5780, 5975) and are never called. Checked with AE: the Venus peak is 2026-11-27T01:47Z at −4.87; the next Mercury transit is 2032-11-13T08:54Z (the next Venus transit is 2117); geocentric Moon–Antares minima run 0.06°–0.51° every month from 2026-11-11 to 2027-11-28; ring_tilt changes sign 2038-10-21, 2039-04-09 and 2039-07-18. Costs: SearchPeakMagnitude 0.3 ms, SearchTransit 2.4 ms, 55 lunar apsides 5.8 ms.

**Verifier corrections.** (1) The worker never loads sky.json; worker.js imports only almanac, events, paths and bodies. Hard-code the 5 star J2000 RA/Dec values in events.js. topoDir already uses astrometric J2000 (Equator ofdate=false, events.js:363), so fixed J2000 vectors are consistent. (2) The events op already measures about 197 ms for 730 days (HCMC), not well under 100 ms. Set the budget as 'adds ≤ 20 ms'. (3) Merge the triple ring-plane crossing of 2038–39 into one event. (4) This is several new sources, filter chips, icons and timebar colours plus tests, which is closer to M than S.

### `bug-eqgrid-j2000`: Bug: the equatorial grid is drawn in the J2000 frame, 5.2–5.5° off the true celestial pole at the ends of the time range

*bug · impact 3→2 · effort S→S · verdict **revise***

**Pitch.** At night in 1066 the RA/Dec grid is centred on Polaris while the stars visibly turn around a point 5° away. That teaches the opposite of what the app's precession story intends.

**Current state.** sky.js:338-355 builds the eqGrid once from raDecToScene in J2000, and the mesh never receives a matrix (sky.js:323-326, 530). Only the alt-az grid is re-oriented per frame (sky.js:475). frames.js:362-377 folds the precession-nutation matrix PN into E = PN·Rz(GAST) without exposing PN. Repro: #loc=48.85,2.35&t=1066-04-24T21:00:00Z&view=sky&ly=bgoscCnmkazhlq&cam=s:0,45,60 (astro-paris-1066-north.png). The grid's pole sits on Polaris, but snapshot earthMatrix·(0,1,0) is 5.20° from the J2000 pole in 1066 and 5.54° in 2999 (measured with --eval). In those years Polaris is 6.2° (1000) and 5.05° (3000) from the true pole.

**Proposal.** In snapshot.js keep a preallocated Float64Array(16) pnMatrix = embed(S·PN·Sᵀ). Either split earthRotationM3 to also write PN, or compute PN·Rz(GAST)·Rz(−GAST) from E3. In sky.js apply(snap): eqGrid.mesh.matrixAutoUpdate = false and copy pnMatrix into eqGrid.mesh.matrix only when it changes by more than 1″ (it changes slowly; no allocation). Label the layer 'Equator & poles of date' in the Layers panel, or offer both J2000 and 'of date'. Add a test: the eqGrid pole transformed by pnMatrix equals earthMatrix·ŷ within 1e-9.

**Risks.** None functionally. The ecliptic (sky.js:357-366) can stay J2000: the ecliptic precesses only about 47″ per century. Make sure the J2000 RA/Dec printed in the body card is still labelled J2000.

**Files.** `js/astro/snapshot.js`, `js/astro/frames.js`, `js/render/sky.js`, `js/ui/layers.js`, `test/astro.snapshot.test.mjs`

**Verifier evidence.** The behaviour is real. sky.js:338-355 builds eqGrid once with raDecToScene, and only altAz is re-oriented (sky.js:475). astro-paris-1066-north.png shows the grid's pole on Polaris in 1066. AE gives Polaris 6.21° from the pole of date in 1000 and 5.05° in 3000. However, ASTRONOMY.md:75-78 documents that 'the grids … are placed once at load, in J2000 scene coordinates', so this is a design or labelling gap rather than a bug. layers.js:29 labels the layer only 'Right ascension and declination'. The pole moves about 20″/yr, so today's offset is about 0.14°: invisible.

**Verifier corrections.** No change to frames.js or snapshot.js is needed. The snapshot already stores gastDeg (snapshot.js:226), and earthMatrix = S·PN·Rz(GAST)·Sᵀ, where S·Rz(θ)·Sᵀ is three's rotation.y. So S·PN·Sᵀ = earthMatrix · makeRotationY(−GAST). In sky.js apply(), set eqGrid.mesh.matrixAutoUpdate = false and multiply into its matrix with one scratch Matrix4 (no allocation). Relabel the layer 'Equatorial grid (of date)', or offer both. The eqGrid layer is off by default and the effect matters only far from 2000, so impact is low.

### `deep-sky-objects`: Deep-sky objects: the Messier catalogue and southern showpieces as procedural, true-size sprites ★

*feature · impact 4→3 · effort L→L · verdict **revise***

**Pitch.** Under a dark sky the Andromeda Galaxy appears as a real 3°×1° smudge rising over the horizon. The Orion Nebula glows in the sword, Omega Centauri and the Magellanic Clouds hang in the southern sky, and each one sharpens as you zoom. Tap one for 'M31 · 2.5 million light-years · the light left before humans existed'.

**Current state.** There are no DSOs anywhere (no match for messier, nebula or andromeda in js/). The sky has only 5,044 stars to mag 6 (catalog.js:13, quality.js:25-37) plus the Milky Way raster. At 5° FOV the screen is nearly empty (astro-jupiter-fov5.png). Picking covers only the nine bodies (main.js:1072-1073, picking.js:139).

**Proposal.** 1) Add scripts/build-dso.mjs, which reads a vendored, sha256-pinned OpenNGC CSV (CC BY-SA 4.0) plus a hand-checked list of 110 Messier and about 30 showpieces (LMC, SMC, ω Cen, 47 Tuc, η Car nebula, Double Cluster, Coathanger…). Each record: [id, type, ra×1000, dec×1000, mag×10, major′, minor′, PA, distance ly]. The output, data/dso.json, is about 8 KB and lazy-fetched on idle, so it is not in the tier budget. The service worker caches it cache-first (sw.js:4). 2) New js/render/dso.js: one instanced quad at infinity per object, sized to its true angular extent, with a procedural fragment shader per type. Galaxy: exponential disc plus bulge with axis ratio and PA. Globular cluster: King profile plus hash-noise resolved stars that appear above a zoom threshold. Open cluster: sprinkled stars. Emission nebula: fbm noise seeded by id, grey-green for 'eye' realism. Planetary nebula: small blue-green ring. Visibility compares surface brightness with the sky brightness already modelled (skyViewExposure, Sun altitude, Moon phase and altitude), so objects fade at twilight and under a full Moon. 3) Picking: add DSO candidates to pickDir and a details card with distance and a light-time line. 4) Add layer code 'd' in LAYER_CODES. Tier: the low tier draws only mag < 6 objects without noise octaves. Text mode: a 'Tonight's showpieces' list (altitude at 22:00, through AE.DefineStar + SearchRiseSet).

**Risks.** Licence: OpenNGC is CC BY-SA, so data/dso.json inherits share-alike. That is fine as a separate data file; note it in THIRD_PARTY_NOTICES. Hand-entered Messier facts avoid the issue entirely. Procedural looks must stay subtle (the naked eye sees grey smudges), or they will read as fake. About 10 KB of JS in every tier. The selection-model extension is shared with comets and stars.

**Files.** `scripts/build-dso.mjs`, `data/dso.json`, `js/data/dso.js`, `js/render/dso.js`, `js/main.js`, `js/camera/picking.js`, `js/core/url-state.js`, `js/ui/layers.js`, `vendor/VENDOR.json`, `THIRD_PARTY_NOTICES.md`

**Verifier evidence.** There is no Messier, nebula or galaxy code in js/ (grep). Picking uses bodies only (main.js:1072-1073; picking.js pickDir). sky.json has 5,044 stars only. sw.js:23 PRECACHE lists only index.html, the manifest and two icons. data/ is cache-first only after the first fetch.

**Verifier corrections.** (1) A lazily fetched data/dso.json is not offline-first: it is cached only after a visit that fetched it. At about 8 KB, load it at boot (it counts in the tier budget, which has room) or post it to the SW precache message. (2) Avoid vendoring OpenNGC (CC BY-SA). About 140 hand-checked showpieces from public catalogue facts are enough and keep the MIT plus attribution story simple. (3) At the default 70° FOV most objects are a few pixels across; the payoff comes at zoom, so tie it to a lowered FOV clamp. Keep the procedural looks to faint grey smudges, or they read as fake. (4) The selection-model extension is shared with the star and comet ideas; build it once.

### `star-info-light-time`: Tap any star: name, Bayer designation, distance and 'the light you see left in 1476'

*feature · impact 4→3 · effort M→L · verdict **revise***

**Pitch.** The app already says 'The light you see from Saturn left 1 h 21 min ago'. Extend that to every star: tap Betelgeuse and read 'α Orionis · red supergiant · about 550 light-years — this light left around 1476, before Columbus sailed'. It is a small feature that people share.

**Current state.** Stars cannot be picked. main.js:1072-1073 builds pick candidates from bodies only. sky.json keeps names only for mag ≤ 3.0 (build-sky.mjs:27; 156 names), although data/raw/starnames.json has 602 proper names and 3,442 Bayer/Flamsteed designations that go unused. No parallax is shipped (build-sky.mjs:42-57 packs hip, ra, dec, mag and bv only).

**Proposal.** 1) Add scripts/build-starinfo.mjs, which writes a lazy data/starinfo.json: hip → [name, bayer + flam + con (from starnames.json), parallax in mas (Yale Bright Star Catalogue BSC5, public domain via NASA HEASARC, joined on HD numbers already present in starnames.json; or the Hipparcos new reduction, ESA, with citation)]. That is about 4,000 rows, roughly 60 KB raw and 20 KB gzipped, fetched on the first star tap and not counted in the tiers. 2) Picking: pickDir over the visible stars (prefix by tier magnitude), only on click and never per frame. Fall back to stars when no body is within 18 px. 3) The card reuses the body-card layout: designation, spectral class estimated from B−V, magnitude, constellation, altitude/azimuth, rise/transit/set through AE.DefineStar('Star1', ra, dec, distLy) + SearchRiseSet (the same code path as planets), and the distance and light-departure year with ±σ from the parallax error. Selection: sel=hip:27989. Text mode: the star card works whenever the catalogue loads.

**Risks.** Distances of far stars are uncertain (Betelgeuse ±20%), so print 'about' and round. Requires the extras-selection mechanism (shared with comets and DSOs). Check that BSC5's licence is acceptable (it is commonly treated as public domain). Keep it lazy so it does not grow sky.json, which is at 159 KB of a 200 KB budget.

**Files.** `scripts/build-starinfo.mjs`, `data/starinfo.json`, `js/main.js`, `js/camera/picking.js`, `js/ui/body-card.js`, `js/core/url-state.js`, `js/astro/almanac.js`

**Verifier evidence.** Stars cannot be picked (main.js:1072 builds candidates from bodies only). data/raw/starnames.json has 4,869 rows: 602 proper names and 3,442 Bayer or Flamsteed designations, with HD and HIP ids. sky.json carries 156 names (build-sky.mjs:27, NAME_MAG_LIMIT 3.0) and hip/ra/dec/mag/bv. No parallax exists anywhere in data/raw: stars.6.json features hold only mag and bv. url-state.js:329-333 accepts only BODY_IDS for sel.

**Verifier corrections.** (1) A parallax source has to be newly vendored. Use the Hipparcos new reduction (van Leeuwen 2007, VizieR I/311) keyed by HIP, which sky.json already stores per star. That avoids an HD join against BSC5, whose parallaxes are pre-Hipparcos, poor for most stars, and of unclear licence. (2) The sel=hip:… selection-model change touches about 8 modules (url-state, store, body-card, beams, labels, picking, actions), so this is closer to L than M. (3) Round departure years to the parallax error, e.g. 'around the 1400s' for Betelgeuse (±20%), not 'left in 1476'.

### `visibility-year-planner`: 'Best time to observe X': a 12-month planet visibility chart

*feature · impact 4→3 · effort M→M · verdict **keep***

**Pitch.** One glance shows when each planet is worth going out for this year. A band per planet marks each night's dark-sky window, coloured by altitude, with opposition and conjunction markers. Tap a night to jump the clock there. It is the classic almanac chart, computed for your exact location.

**Current state.** almanac.js:443-464 tonight() rates only one night (verdicts excellent, good, low, twilight, daytime, not-visible). The worker OPS (worker.js:45-69) have nothing multi-night. Events give single instants (oppositions, elongations), not visibility windows. A user cannot answer 'when is Saturn best placed this year?'.

**Proposal.** Add a worker op 'visibilityYear' {observer, fromMs, nights: 365}. For each body, compute RA/Dec once per day (GeoVector; topocentric only for the Moon). Then, for each night, evaluate the altitude analytically every 15 min across the dark window (sin h = sin φ sin δ + cos φ cos δ cos H, with H from linear GMST), reusing almanac's dark/up thresholds. That is about 120k trig evaluations (about 10 ms) with no per-sample AE.Horizon. Return a Uint8Array per body (minutes above 15° in darkness / 5) and a Float32 best-altitude array, both transferable. UI: an SVG chart in a new 'Year' section of the Details tab (or an Events sub-view) with one row per body, opposition and conjunction markers from the existing events list, and click-to-jump. Add a sentence summary: 'Saturn: best Sep–Nov 2027, highest 68° at 23:10 in early October'. It is pure DOM, so it fully works in text mode.

**Risks.** The analytic altitude ignores refraction and parallax; that is fine for a planning chart, but say 'approximate' for the Moon. Keep the request cancelled and debounced on observer changes (the client.js signal is already supported). About 4 KB of JS.

**Files.** `js/astro/almanac.js`, `js/astro/worker.js`, `js/ui/body-card.js`, `js/ui/index.js`, `test/astro.almanac.test.mjs`

**Verifier evidence.** almanac.js:443 tonight() and decideVerdict (almanac.js:364-381) rate only one night. Worker OPS (worker.js:45-69) have no multi-night op. body-card.js has no year view (grep). The analytic altitude approach avoids AE.Horizon per sample, and transferable typed arrays are already supported by the worker's buffer collector (worker.js:85-90).

**Verifier corrections.** Chart the planets only. The Moon's visibility changes nightly with a 29.5-day cycle, so it adds noise to a 12-month chart; show a monthly dark-Moon band instead. Add opposition and conjunction markers from the existing events op rather than recomputing them.

### `body-card-moons-rings-libration`: Details card: Jupiter's moon line-up, Saturn's ring tilt and the Moon's libration (works in text mode)

*feature · impact 3→2 · effort S→S · verdict **keep***

**Pitch.** Jupiter's card shows tonight's line-up: 'Callisto · Io · ● · Europa · Ganymede', as an observer's diagram and a sentence. Saturn's card says 'Rings open 6.5° (south face), edge-on in 2038'. The Moon's card says 'Libration 5.6° toward the east: Mare Crisium is near the limb tonight'.

**Current state.** body-card.js:88-100 shows altitude, azimuth, rise/transit/set, distance, magnitude, phase, elongation, size, constellation, RA/Dec and sub-point only. snapshot.js:269-273 calls AE.Illumination but discards ring_tilt (now 6.51°). AE.JupiterMoons and AE.Libration (astronomy.js:3568, 1684; libration now elon 5.57°, elat 1.42°) are unused.

**Proposal.** Add a 'moons' fact for Jupiter: JupiterMoons(t − lightTime). Project the four jovicentric offsets onto the sky plane (east/north unit vectors at Jupiter's direction) and convert to arcminutes. Draw a 1-row SVG strip with E/W labels and flag moons in transit, eclipsed or occulted (simple disc and shadow-cylinder tests). Add a 'rings' fact for Saturn: Illumination.ring_tilt, face (sign), and the next edge-on date from a 10-day scan. Add a 'libration' fact for the Moon: AE.Libration(t) elon/elat turned into a direction ('toward the NE') plus the best-presented limb feature from a 6-entry table (Crisium, Grimaldi, Mare Orientale…). Compute these in the 4 Hz 'full' readout path, not per frame. This is the cheap, text-mode half of eyepiece-mode and shares its astro helper (js/astro/moons.js).

**Risks.** Very low. JupiterMoons accuracy degrades far from the present (L1.2 theory), so show it under the Reduced-accuracy badge outside 1800–2200.

**Files.** `js/astro/moons.js`, `js/astro/snapshot.js`, `js/ui/body-card.js`, `test/astro.moons.test.mjs`

**Verifier evidence.** body-card.js:88-100 facts: altitude, azimuth, rise/transit/set, distance, magnitude, phase, elongation, size, constellation, RA/Dec J2000, RA/Dec of date and sub-point. There is no moons, rings or libration fact. JupiterMoons, Libration and ring_tilt are unused in js/ (grep). Measured: JupiterMoons 0.02 ms; ring_tilt 6.54° on 2026-11-03; edge-on crossings 2038-10-21, 2039-04-09 and 2039-07-18. Libration on 2026-11-03T00Z is elon 5.28°, elat −0.12°; the proposal's 5.57°/1.42° is a different instant, which is fine. The Moon mesh already shows libration visually (bodies.js:8).

**Verifier corrections.** The next edge-on date is a triple crossing in 2038–39; phrase it as 'edge-on from Oct 2038 to Jul 2039'. Compute the facts in the 4 Hz full-detail path, as proposed.

### `time-machine-sky`: Time-machine sky: star proper motion, pole of date, precession circle and the drifting equinox

*accuracy · impact 3→2 · effort M→M · verdict **revise***

**Pitch.** The app spans 1000–3000, so show it. A precession circle with year ticks traces the pole's journey. A marker shows today's pole 0.74° from Polaris (closest, 0.46°, in 2100; 6.2° in 1000). The ♈ March-equinox point visibly slides from Pisces into Aquarius in 2598. Arcturus and α Centauri sit where they really were in 1066, not where they are today.

**Current state.** Stars are fixed at J2000 with proper motion explicitly not applied (ASTRONOMY.md:176, :297, 'the fastest naked-eye stars shift by up to about a degree 1000 years from 2000'). build-sky.mjs:42-57 ships no proper-motion columns. Constellation segments are built from the lines file's own RA/Dec (catalog.js:136-160), not from star indices, so they could not follow moving stars anyway. No pole or equinox markers exist. I verified with AE that the vernal point enters Aquarius in 2598 and that Polaris is 6.21° from the pole in 1000 and 5.05° in 3000.

**Proposal.** 1) build-sky.mjs: add pmRA/pmDec (mas/yr) only for stars with |μ| > 100 mas/yr (about 150 stars, roughly 3 KB), from BSC5 (public domain) joined by HD/HIP. Snap constellation-line endpoints to star indices at build time (match within 0.01°) and emit index pairs, so figures can move with their stars. 2) catalog.js: a pure applyProperMotion(stars, years) that rewrites those few direction entries in place. sky.js calls it only when the sim year moves more than 5 years, updating the BufferAttribute range (no allocation). 3) New 'Precession' layer in sky.js: a static line around the J2000 ecliptic pole (radius 23.44°) with millennium ticks labelled Thuban −2800, Polaris 2100, Errai 4000, Alderamin 7500, Vega 14000 (outside the clock range, labelled illustrative). Add a live 'pole of date' crosshair from earthMatrix·ŷ and a ♈/♎ equinox-of-date marker from Rotation_EQD_EQJ·x̂. 4) Sky-now line: 'Polaris is 0.74° from the pole'. Tests: Arcturus position at 1000 AD against a rigorous space-motion calculation within 1′.

**Risks.** sky.json grows about 4–6 KB in every tier: it is at 159 of 200 KB, and low-tier headroom is 90 KB. Linear proper motion ignores radial-velocity foreshortening (under 1′ for these stars over 1000 years). Changing the constellation format to index pairs means a v2 sky.json and a decoder migration. Precession-circle ticks far outside 1000–3000 must be labelled as illustrative.

**Files.** `scripts/build-sky.mjs`, `data/sky.json`, `js/data/catalog.js`, `js/render/sky.js`, `js/render/labels.js`, `js/ui/sky-now.js`, `docs/ASTRONOMY.md`, `test/data.catalog.test.mjs`

**Verifier evidence.** ASTRONOMY.md:166-168 says proper motion is not applied. build-sky.mjs:42-57 packs no proper-motion columns. catalog.js:136-160 builds constellation segments from the lines file's own RA/Dec, as claimed. AE gives Polaris's distance from the pole of date as 6.21° in 1000, 0.74° in 2000, 0.63° in 2026, 0.46° in 2100 and 5.05° in 3000.

**Verifier corrections.** (1) 'Polaris is 0.74° from the pole today' is wrong: 0.74° is the J2000 value, and in 2026 it is 0.63°. (2) The proper-motion half costs a new raw catalogue, a sky.json v2 format and a decoder migration to index-pair constellations. That buys shifts of at most about 0.6–1° over 1000 years for a handful of stars (Arcturus, α Cen), barely visible at 70° FOV. Drop it, or limit it to an inline table of about 10 fast bright stars without moving the constellation figures. (3) Keep the cheap, visible parts: a pole-of-date marker (earthMatrix·ŷ), the precession circle, and the equinox-of-date marker. Fold them into the eqGrid of-date fix.

### `bug-eclipse-visibility-single-instant`: Bug: eclipse visibility is judged at a single instant, so a total eclipse below the horizon is billed 'visible here'

*bug · impact 2→2 · effort S→S · verdict **keep***

**Pitch.** An observer whose totality happens with the Sun below the horizon is told 'Total solar eclipse visible here' in the same card that says maximum is below the horizon. Lunar eclipses are judged only at mid-eclipse, so moonrise and moonset eclipses are reported as not visible.

**Current state.** events.js:251-259 picks the title from ls.kind alone ('Total solar eclipse visible here'), and events.js:265-268 only checks peak.altitude for the sentence. Repro: observer loc=28.10,-46.97 (Atlantic, near the sunrise end of the path), events from 2027-07-25. AE returns kind 'total' with C2 and C3 at −1.27° refracted Sun-centre altitude (upper limb about −1.0°, so totality is invisible) and partial end at +9.6°. The card reads 'Total solar eclipse visible here' and 'Maximum comes with the Sun below the horizon'. Lunar: events.js:216-217 sets visibleHere and view from the Moon's altitude at the peak only, ignoring sd_partial/sd_total, so a site that sees the umbral phase at moonrise is told 'Not visible from here'.

**Proposal.** Solar: compute totalityVisible = kind ∈ {total, annular} && max(c2.alt, c3.alt) + 0.27° > 0. If false, title 'Partial solar eclipse here (totality below the horizon)', or 'Total eclipse at sunrise' when only part of totality is visible. Lunar: sample the Moon's altitude at U1, U2, peak, U3 and U4 (peak ± sd_partial/sd_total, already available) and phrase it 'Visible from moonrise at 17:42, during totality'. Add unit tests with the repro coordinates.

**Risks.** None; the change is local to two event sources.

**Files.** `js/astro/events.js`, `test/astro.events.test.mjs`

**Verifier evidence.** Reproduced in node with the real events.js. At 28.10, −46.97, AE returns kind total with P1 −11.41°, C2 −1.31°, peak −1.27°, C3 −1.23° and P4 +9.57°. upcomingEvents emits 'Total solar eclipse visible here' together with 'Maximum comes with the Sun below the horizon' (events.js:256, 265-268). For lunar eclipses I took 16 umbral eclipses from 2026 to 2036 × 12 world cities: 12 of 192 pairs have the Moon below the horizon at the peak but part of the umbral phase above it. All 12 are reported 'Not visible from here' with view 'orbit' (events.js:216-226).

**Verifier corrections.** AE eclipse altitudes are refracted Sun-centre values, so the upper-limb test (+0.27°) is right. For lunar eclipses, also set visibleHere and view: 'sky' when any umbral contact is above the horizon, so the jump goes to sky view. The lunar case is the more common user-facing error and should be prioritised over the solar sunrise/sunset edge case.

### `analemma-sun-path`: Analemma and Sun-path diagram in sky view, plus the subsolar figure-8 on the globe

*feature · impact 3→3 · effort M→M · verdict **keep***

**Pitch.** In sky view, a golden figure-8 shows where the Sun stands at this clock time on every day of the year, and arcs show today's, the June solstice's and the December solstice's paths with hour ticks. Photographers can see where the Sun will set on any date. On the globe the subsolar point traces its figure-8 between the tropics.

**Current state.** trails.js:94-131 draws only geocentric paths at infinity, in the fixed star frame. There is no path in the observer's horizon frame. sky.js:331-335 and 475 show the alt-az grid is already a line layer re-oriented each frame from the observer's ENU basis, which is exactly the frame an analemma lives in. almanac.js:216-229 sunAltitudeSeries computes Sun altitudes but not directions.

**Proposal.** Add a worker op 'sunFigures' {observer, clockMs, tz}: 365 samples of the topocentric Sun direction at the same zone clock time each day (AE.Equator + Horizon to alt/az, then the local ENU unit vector), and 3 day arcs at 10-min steps, about 1,000 points in all. Add a new line layer in sky.js parented like altAz (matrixAutoUpdate false, makeBasis from east/up/south), with month ticks and labels for solstices and equinoxes. Recompute only when the observer, the clock time of day (±5 min) or the year changes. Globe: plot the subsolar lat/lon at fixed UT for 365 days as a polyline on the Earth (shared with the eclipse-path surface-line code). Add layer code 'y'. Low tier: no ticks. Text mode: show the solstice sunrise and sunset azimuths as text ('Midsummer sunset 303° WNW').

**Risks.** DST jumps break the figure-8 when 'same clock time' uses the zone time, so use standard (non-DST) time and say so. Small JS cost (about 4 KB). Avoid clutter: draw it only when the layer is enabled.

**Files.** `js/astro/almanac.js`, `js/astro/worker.js`, `js/render/sky.js`, `js/core/url-state.js`, `js/ui/layers.js`

**Verifier evidence.** There is no analemma or Sun-path code (grep). trails.js:94-131 draws only geocentric paths in the star frame. The alt-az grid is a line layer re-oriented per frame from the ENU basis (sky.js:331-335, 475), which is the right parent for horizon-frame figures. sunAltitudeSeries (almanac.js:216) returns altitudes only.

**Verifier corrections.** Sampling at the same standard-time clock reading each day is the same as sampling at a fixed UT time of day. Use the current UT time of day directly, with no tz or DST logic. Recompute only when the observer or the UT hour (±5 min) changes. For the globe figure-8, reuse the eclipse-path surface-line renderer if that lands first.

## Lens: Cross-cutting (completeness critic)

Completeness critic. The seven lenses went deep, but always inside the app's current frame: one observer on Earth, nine bodies, no sound, mostly the present day, and visual output only. The gaps that cut across lenses are these. There is no audio of any kind (no AudioContext anywhere in js/, css/ or index.html). Nothing moves visibly at 1x speed, because there are no satellites. There are no human-made objects. The 1000–3000 time machine has no history content, and dates before 1582 are shown in the proleptic Gregorian calendar, so the SN 1054 dawn appears as "Mon 10 Jul 1054" instead of 4 July (see complete-kaifeng-1054.png). There is no flat-map teaching view and no second observer. The exposure is a hand-tuned curve of Sun altitude with no model of night vision. The render-on-demand loop never uses its idle frames. The biggest single opportunity is "Stand on Mars". Astronomy Engine already exposes Mars's rotation model (RotationAxis handles Body.Mars), the app already calls RotationAxis for the Moon, and the repo began life as "Mars Direction Globe". A first phase limited to sky view can reuse the star sky unchanged.

### `stand-on-mars`: Stand on Mars: a Mars observer with a butterscotch day, a blue sunset and Earth as the evening star ★

*feature · impact 5→4 · effort XL→XL · verdict **revise***

**Pitch.** Switch worlds and stand in Jezero Crater. The day sky is butterscotch and the sunset glows blue around a Sun two-thirds its usual size. Low in the west after sunset is a bright blue 'evening star', Earth, with the Moon beside it, and a beam reads 'the light from home left 11 min ago'. Phobos rises in the west twice a sol. This completes the repo's own arc: it started as 'Mars Direction Globe', pointing at Mars, and would end by letting you stand on it.

**Current state.** All the astronomy assumes an observer on Earth. snapshot.js:156 builds AE.Observer and snapshot.js:291 uses AE.Horizon. The scene is centred on Earth, using the S mapping and earthMatrix in frames.js, and the sky-view atmosphere is the Preetham Earth sky in render/ground.js. Mars is only a target, one of the nine entries in the BODIES contract (astro/bodies.js:4,36). However, the vendored engine already supports Mars's rotation: RotationAxis handles case Body.Mars (vendor/astronomy-engine/astronomy.js:9007, around line 9085), and the app already calls RotationAxis for the Moon (snapshot.js:320, frames.js:583). The git history begins with 'Update title for Mars Direction Globe project'. Nothing in the codebase mentions Phobos, sols or Mars time.

**Proposal.** Phase 1, sky view only (M–L). Add a pure module js/astro/host-mars.js. For each body it computes the Mars-centred vector HelioVector(body) − HelioVector(Mars), with a light-time iteration. Earth and the Moon become targets, and Mars is dropped from the list. The body-fixed frame comes from RotationAxis('Mars') (pole RA/Dec plus spin angle W), giving alt/az for an areographic lat/lon. A Mars clock (MSD, MTC and LMST, using the Allison & McEwen 2000 / Mars24 algorithm) goes in a pure core module, and the timebar shows 'Sol 1,712 · 16:40 LMST'. Phobos and Deimos come from mean orbital elements: Phobos rises in the west and its transits across the Sun are visible. The stars are at infinity and identical from Mars, so sky.js, the constellations and the Milky Way are reused untouched; only the horizon frame changes. Add a Mars sky shader that sits beside ground.js's Preetham patch: a dust-absorption base colour for a butterscotch day, plus a narrow forward Mie lobe for micron-sized dust that gives a blue aureole around the setting Sun. A 'place' list of landing sites (Jezero, Gale, Elysium Planitia, Utopia, Chryse, Ares Vallis, Meridiani) replaces the cities. Phase 2 (L–XL): a Mars globe with a lazy-loaded 2K texture (Solar System Scope, CC BY 4.0), loaded only when Mars mode opens, plus a thin dusty limb and beams from the landing site. The URL gets host=mars. Tiers: the sky shader is analytic, so all tiers get it, and the Mars texture is only loaded in phase 2.

**Risks.** This is the largest architectural change on any list. The scene, the BODIES contract (Mars as host, Earth as target), the almanac, events, tz and format all assume Earth. Mitigation: phase 1 changes only the snapshot source and the sky-view ground, and globe view stays on Earth. The Mars texture (about 0.5–1 MB) must stay outside the initial tier budgets in scripts/check-size.mjs; it is lazy-loaded and still within the 12 MB staged-site budget. Accuracy: the IAU Mars rotation model is good to arcminutes. The Phobos mean elements drift and are only good for about decades, so they would carry a badge. The Mars sky colour is illustrative, tuned to rover imagery and not physically derived. Purity is kept, because host-mars.js only uses ae.js.

**Files.** `js/astro/host-mars.js (new)`, `js/astro/snapshot.js`, `js/astro/frames.js`, `js/astro/bodies.js`, `js/core/tz.js`, `js/core/url-state.js`, `js/render/ground.js`, `js/render/shaders/ground.glsl.js`, `js/render/beams.js`, `js/ui/location.js`, `js/ui/timebar.js`, `js/main.js`

**Verifier evidence.** Grep finds no Phobos/Deimos/sol/LMST/Mars24 anywhere in js/. snapshot.js:156 builds AE.Observer for Earth, :291 calls AE.Horizon, :319 calls RotationAxis('Moon'). frames.js:583 iauBodyMatrix and :569 dirToAltAz already exist. vendor astronomy.js:9084 has the IAU Mars pole and W model, and :3777 BackdatePosition(date, observerBody, targetBody, aberration) accepts any observer body. Only JupiterMoons exists for satellites. The first commits include 68b4e63 'Update title for Mars Direction Globe project'. bodies.js:4 says BODIES order is a contract shared by beams, glyphs and the 1-9 keys. rig.js:47 puts the sky-view eye on Earth (EYE_R=1.0005). check-size.mjs passes with low at 3.71/3.80 MB, medium 4.19/4.30 and high 5.24/5.40. modgraph.mjs:106 follows dynamic imports, so every new module counts toward every tier. three r170 examples (VENDOR.json) ship no Mars texture.

**Verifier corrections.** 1) Don't write a light-time iteration. AE.BackdatePosition(t,'Mars',target,true) already returns the light-time and aberration corrected Mars-to-target vector, including the Moon. 2) Keep the BODIES contract. In Mars mode, swap slot 4 to an Earth entry through a host table, so beam instances, glyph vertices, 1-9 keys and url-state BODY_IDS stay valid. Don't rebuild the list. 3) Build the local frame from the existing iauBodyMatrix(RotationAxis('Mars')) plus dirToAltAz. 4) The file list is missing pieces. rig.js (sky-view eye on Earth's surface), render/bodies.js and earth.js (hide the globe, draw Earth as a point), almanac.js and events.js (AE.SearchRiseSet and the eclipse searches need an Earth Observer, so hide or reimplement them), sky-now.js and body-card.js (Earth-specific wording, twilight classes) and labels-feed all need changes. 5) Budget: the low tier has about 90 KB of raw headroom, and the crawler counts dynamic imports. Mars code (host module, clock, sky shader, sites) has to fit inside that, or the budgets must be re-baselined explicitly. 6) The Mars texture has to be fetched from Solar System Scope (CC BY 4.0) and added to VENDOR.json and the credits. Phase 1 alone is realistically L–XL. Ship it as a sky-view-only 'Mars sky' mode first.

### `live-satellites`: The ISS and bright satellites: a beam that visibly moves at 1x, with real pass predictions ★

*feature · impact 4→4 · effort L→L · verdict **revise***

**Pitch.** At real-time speed everything in the app is still, except the ISS. It slides across the globe at 7.7 km/s and its beam sweeps visibly. In sky view it crosses the whole sky in about six minutes, then fades to nothing mid-sky as it enters Earth's shadow. 'Can I see the space station tonight?' is the most common sky question people ask, and the app would answer it with a countdown.

**Current state.** There is no satellite code. A word-boundary grep for ISS, Tiangong, Hubble, SGP4 or 'satellite' across js/, docs/ and README returns nothing. Every tracked body comes from the 9-entry BODIES contract (bodies.js:4), and the frame snapshot is only recomputed when sim time moves by 0.5 s or more. data/ is served cache-first per VERSION (sw.js:4-6). The deploy workflow (.github/workflows/pages.yml) runs only after CI or on manual dispatch, with no schedule.

**Proposal.** 1) A pure js/astro/sgp4.js: near-Earth SGP4 only, about 300 lines, since LEO objects need no SDP4. Test it against Vallado's published verification vectors under test/. 2) Data: scripts/fetch-tle.mjs runs at build time, not at run time, in a scheduled pages.yml job (add a daily cron). It writes data/tle.json for about 6 objects: ISS, Tiangong, HST and a few bright rocket bodies, each with its epoch. 3) A new render/satellites.js module. On the globe it draws a moving dot, a ground track for ±1 orbit (one preallocated line buffer) and a short beam from the observer whenever the object is above the horizon. In sky view it draws a point whose magnitude comes from range and phase angle (ISS standard magnitude about −1.8 at 1000 km), switched off by a cylindrical Earth-shadow test (reusing the geometry in astro/shadow.js). 4) The astro worker computes 'Next visible passes' for 10 days (start, max and end az/alt, magnitude, and whether the pass ends in shadow). These show in Sky now and the Events panel, with a jump that frames the pass in sky view. 5) Staleness: hide satellites outside ±14 days of the TLE epoch and outside the launch–deorbit window (ISS 1998–2030). Show a 'TLE n days old' chip. Tiers: everything is cheap (one SGP4 call per object per frame snapshot).

**Risks.** It bends 'offline-first, fixed data'. TLEs go stale (ISS error is about 1–3 km a day, plus unpredictable reboosts), so the prediction window must be honest and labelled. The runtime stays offline and R4 holds, because only the build script touches CelesTrak, the same way fetch-vendor.mjs does. sw.js caches data/ cache-first per VERSION, so tle.json needs its own stale-while-revalidate rule or a hashed name, or returning visitors keep old elements forever. The snapshot cadence must allow ISS motion (0.5 s of sim time is about 4 km, which is fine). The deploy would run daily, so CI must stay green on a schedule.

**Files.** `js/astro/sgp4.js (new)`, `js/astro/worker.js`, `js/render/satellites.js (new)`, `js/main.js`, `js/ui/sky-now.js`, `js/ui/events-panel.js`, `scripts/fetch-tle.mjs (new)`, `.github/workflows/pages.yml`, `sw.js`, `test/astro.sgp4.test.mjs (new)`

**Verifier evidence.** A grep for ISS, Tiangong, Hubble, SGP4 and satellite finds nothing in js/, docs/ or README. loop.js:31 sets SNAP_STALE_MS=500, and :253 recomputes the snapshot only on a 0.5 s sim-time change. clock.js:533 isAnimating() is false at Live 1x, so at 1x the loop redraws only on those 0.5 s steps. sw.js:4-6 makes data/ cache-first per VERSION, and sw.js:9-11 plus a test tie VERSION to js/version.js. pages.yml triggers only on workflow_run and workflow_dispatch. shadow.js exports discVisibleFraction(rs, ro, sep), which can serve as the Earth-shadow test.

**Verifier corrections.** The risk note gets the cadence wrong: '0.5 s ≈ 4 km is fine' only holds on the globe. In sky view an overhead ISS pass (h≈420 km) moves v/h ≈ 1.05°/s. At 1x the loop draws only on 0.5 s snapshot steps, so the ISS would jump about 0.5° (about 6 px at FOV 70) twice a second. Fixes: propagate satellites in the render module's update(fi) every frame (SGP4 costs microseconds, and the result goes into preallocated buffers), and add 'a satellite is visible in sky view' to loop.js's continuous condition. VERSION equality is enforced, so a daily TLE refresh needs a network-first or stale-while-revalidate rule for data/tle.json in sw.js, not a daily VERSION bump. Fetch the TLEs in the deploy job (staged only) or in a commit bot, and keep CI green on schedule. Size: SGP4 with sgp4init is realistically 450–600 lines (about 20 KB), plus about 15 KB for the render module. That fits the low tier's roughly 90 KB headroom only if no other new feature lands, so state the budget impact. Use discVisibleFraction(Sun, Earth disc as seen from the satellite) for a penumbra-correct fade.

### `historic-skies`: History's skies: guest stars of 1006, 1054, 1572 and 1604, Julian dates before 1582, a Moments library and 'the sky you were born under' ★

*feature · impact 4→4 · effort M→M · verdict **keep***

**Pitch.** Scrub to dawn on 4 July 1054 over Kaifeng and a new star brighter than Venus blazes beside the waning crescent Moon in Taurus. This is the Crab supernova, the scene some read in the Chaco Canyon pictograph. Then open a Moments library: Columbus's eclipse in Jamaica, Herschel finding Uranus from Bath, Galle finding Neptune where Le Verrier predicted, and Eddington's 1919 eclipse with the Sun among the Hyades. Or type your birthday and see your own sky.

**Current state.** The clock already runs from 1000 to 3000. However: (a) every date is proleptic Gregorian (format.js:26 'proleptic Gregorian', tz.js:339). The SN 1054 first sighting, recorded as 4 July 1054 (Julian), shows as 'Mon 10 Jul 1054' in my screenshot complete-kaifeng-1054.png, and a historian would think the app is wrong. (b) The sky is a static Hipparcos catalogue: grepping for supernova, nova or variable in js/data, sky.js and astro finds nothing. (c) The Events panel only covers the next 12 months (events.js header), and there is no curated content. The deep-link infrastructure that content would need is complete (url-state.js:26 KNOWN_KEYS: loc, t, view, sel, cam). (d) The screenshot shows the crescent Moon in Taurus that morning with no guest star.

**Proposal.** 1) Calendar: pure JD → Julian calendar conversion in format.js and tz.js, used for instants before 1582-10-15. The date chip gets a small 'Julian' tag, with the Gregorian date in its tooltip. The date dialog accepts Julian input, with unit tests. 2) Guest stars: data/guest-stars.json (about 1 KB) holds SN 1006 (Lupus, about −7.5), SN 1054 (Crab, about −6, visible in daylight for 23 days), SN 1181 (Cassiopeia), Tycho 1572 (about −4) and Kepler 1604 (about −2.5), each with RA/Dec and a light-curve template. A small preallocated point layer in sky.js has one magnitude uniform per star, set in apply(snap), and a 'guest star' label kind. 3) Moments: data/moments.json holds about 15 entries, each with a hash, a two-line caption and sources, such as Jamaica 1504 (the lunar eclipse Columbus predicted), Kaifeng 1054, Bath 1781, Berlin 1846, Príncipe 1919, Dallas 2024 and Luxor 2027. They appear as a 'Moments' section in the Events panel plus a 'Surprise me' button, and the motion lens's tour runner can play them if it is built. 4) 'Born under this sky' takes a date (and optionally a time and place), jumps to sky view and writes a generated caption ('Jupiter was in Leo; the Moon was 62% lit'). It hands off to the UI lens's Sky Postcard for sharing.

**Risks.** Historical accuracy: peak magnitudes of the old supernovae are uncertain by about ±1 mag. The Chaco interpretation is debated, so the caption must say 'may record'. Before 1600, ΔT uncertainty (minutes to tens of minutes) shifts local horizon times, which the app already flags as reduced accuracy. The Julian/Gregorian switch was adopted on different dates by different countries (Britain in 1752), so a single 1582 cutover is a simplification and should be stated. The data files are tiny, well inside the per-file budgets. R5 holds because the guest-star buffers are allocated once.

**Files.** `js/core/format.js`, `js/core/tz.js`, `js/ui/timebar.js`, `js/render/sky.js`, `js/render/shaders/sky.glsl.js`, `js/app/labels-feed.js`, `js/ui/events-panel.js`, `data/guest-stars.json (new)`, `data/moments.json (new)`, `scripts/check-size.mjs`, `test/core.format.test.mjs`

**Verifier evidence.** format.js:26 has the proleptic Gregorian weekday, and tz.js:339 daysInMonth is proleptic Gregorian. Grep finds no Julian calendar handling (the 'Julian' hits are the Julian date and Julian year only). My check of complete-kaifeng-1054.png matches the claim: the timebar reads 'Mon 10 Jul 1054 05:05' (Julian 4 Jul 1054), the waning crescent Moon is at 40° E in Taurus, there is no guest star, and the reduced-accuracy warning chip is present. Grep finds no nova, guest or moment content. events-panel.js:2,62 covers the 'Next 12 months'. url-state.js:26 KNOWN_KEYS includes loc, t, view, sel and cam.

**Verifier corrections.** Use AE.DefineStar (vendored) for the guest stars. They then get alt/az, rise and set from the existing almanac paths with no extra maths. J2000 RA/Dec are the right inputs, because the sky is static in EQJ. The Julian display has to reach the timebar ticks and the date-dialog parser as well as the chip. The t= hash stays a UTC/Gregorian ISO instant. Weekdays are the same in both calendars. Handle Julian-only leap days (1500-02-29). Columbus's 1504 eclipse is 29 Feb 1504 Julian, so it is a good unit test. The born-under caption should not depend on the other lens's Sky Postcard to ship.

### `globe-to-map-morph`: Unroll the globe: an animated globe-to-world-map morph with the terminator, twilight bands, sub-body points and tides ★

*visual · impact 4→3 · effort L→L · verdict **revise***

**Pitch.** Press M and the Earth peels open into a flat world map in about a second, still lit by the real Sun. The night side becomes the classic sinusoidal shadow, city lights glow inside it, and nine coloured dots mark where the Sun, Moon and each planet are overhead right now. Run 'a year in 20 seconds' and the shadow swings between the polar day and night of the solstices. Teachers can explain the seasons with it in one gesture.

**Current state.** Only two view modes exist, 'orbit' and 'sky' (store.js:37, url-state.js:26). The Earth surface vertex shader passes the sphere-local position as a varying separately from gl_Position (SURFACE_VERTEX in earth.glsl.js:20-31, with vPosL = position at line 26). All day and night shading, lights, clouds and glint are computed per fragment from that local position and the world normal, so the shading would survive a change in vertex position unchanged. Every BodyState already carries subLatDeg and subLonDeg plus geoDirS (types.js:28-37). The render code uses geoDirS only for the selected body's footprint (earth.js:253,302), and grepping for sublunar finds nothing. There are no twilight-band contours on the globe, and there is no tide model (grepping for tide or tidal finds nothing).

**Proposal.** Add a uniform uMapK (0 to 1) to the shared SURFACE_VERTEX. The plane position is ((uv.x − 0.5)·2π, (uv.y − 0.5)·π)·scale, mixed with the sphere position by uMapK. three's SphereGeometry duplicates the seam vertices, so the map splits cleanly at the antimeridian. vPosL and vNw stay those of the sphere, so lighting, the terminator and clouds come out correct with no new shader logic. The cloud shell uses the same morph. The atmosphere shell fades out as uMapK rises. A 'map' camera mode in rig.js gives 2D pan and zoom with a narrow FOV. pin.js places the pin at its map position. Beams hide in map view and are replaced by sub-body glyphs at subLat/subLon, with an optional visibility footprint contour for each body. Teaching overlays are computed in the earth fragment shader from dot(n, sunDir) and need no textures: civil, nautical and astronomical twilight contour lines; the subsolar and sublunar points; and an optional exaggerated equilibrium-tide overlay on the oceans (h ∝ (3cos²θ − 1) for the Moon plus 0.46× that for the Sun), with 'spring tide' and 'neap tide' labels that follow the phase. The eclipse items' umbra and path of totality would then read like NASA's flat eclipse maps. The URL gets view=map. Tiers: the vertex-shader cost is negligible, so it works on all tiers.

**Risks.** Picking needs an inverse for the plane (an easy analytic inverse). Labels and anchors from labels-feed.js need a map-space path. The equatorial grid and constellations should hide in map view. The tide overlay is an equilibrium-tide teaching model, not a real tide prediction, and must say so. Pole rows of the sphere stretch into the top and bottom edges of the map, which is acceptable in equirectangular. A mid-morph state with the camera inside the shell must be avoided by tweening camera and uMapK together. No rule is bent.

**Files.** `js/render/shaders/earth.glsl.js`, `js/render/shaders/clouds.glsl.js`, `js/render/earth.js`, `js/render/atmosphere.js`, `js/render/pin.js`, `js/render/beams.js`, `js/camera/rig.js`, `js/camera/picking.js`, `js/core/store.js`, `js/core/url-state.js`, `js/ui/view-switch.js`, `js/ui/shortcuts.js`

**Verifier evidence.** store.js:37 has view.mode 'orbit' and the sky mode only. earth.glsl.js:20-31 SURFACE_VERTEX sets vPosL = position and vNw from modelMatrix, as claimed. The current_state is wrong in one place: a 'Sub-points' layer already exists. url-state.js:23 'p'→subpoints, layers.js:40 is 'The spot on Earth directly below each body', and earth.js:297-301 fills uniform uSub[9] from geoDirS, which earth.glsl.js:256-263 draws as dots with halos. So 'nine coloured dots where each body is overhead' already exists on the globe. No twilight contours, no tide model and no path-of-totality line exist. earth.js:280 sets group.matrix from snap.earthMatrix.

**Verifier corrections.** The Earth group is rotated by earthMatrix (earth.js:280). Mixing the plane position into `position` before modelMatrix would make the flat map spin and tilt with GAST and precession. For the plane branch, compute gl_Position = projectionMatrix*viewMatrix*vec4(mapPos,1) without modelMatrix, in a fixed world plane, and keep vPosW and vNw from the sphere. The in-shader ATMO_MODEL aerial perspective uses camera-to-surface geometry and must fade with uMapK. Reuse the existing subpoints layer and do not add new glyphs. The new work is the morph, the map camera, twilight contour lines and the footprint on the map. Drop the tide overlay or make it clearly optional, since it is the weakest part.

### `human-vision-rendering`: Night that looks like night: a human-eye vision model with the Purkinje shift, rod desaturation and dark adaptation

*visual · impact 4→3 · effort M→M · verdict **revise***

**Pitch.** Step out into sky view under a full Moon and the landscape appears in the silvery blue-grey your eyes really see. Colours drain out of everything except Mars, Betelgeuse and Antares, the faint Milky Way is washed out, and when you leave a bright screen the stars take a few seconds to come back, as if your eyes were adjusting. This one perceptual operator lifts every night and twilight image in the app.

**Current state.** Exposure is a fixed function of Sun altitude only. skyViewExposure (sky.js:39) and exposureFor (photometry.js:195-206) never look at the Moon, so a mag −12.7 full Moon and a moonless night render identically (skyground-fullmoon.png shows a vivid Milky Way and a pure-black ground under a full supermoon). Eclipse darkening uses a separate ad-hoc constant, ECL_ADAPT = 0.4 (ground.js:26), and nothing is adapted over time. The final pass is ACES, vignette and dither only (postfx.js:46-67). Grepping for scotopic, purkinje or mesopic finds nothing. The other lenses cover adjacent things: the 'Your real sky' item covers sky luminance, and 'Night-vision red mode' covers UI for observers. None of them covers perception.

**Proposal.** 1) A pure photometry.adaptLuminance(sunAlt, moonAlt, moonIllum, obscuration, [skyBrightness]) estimates the scene's adapting luminance in cd/m². It uses a twilight luminance table plus the Krisciunas & Schaefer 1991 moonlight term, and can use the light-pollution value if the sky lens's Bortle item lands. 2) A temporal adapter in loop.js tracks a fast cone time constant (about 0.3 s) and a slow rod time constant compressed for UX (about 4 s rather than 20 minutes). It holds during clock tweens and fast time, and is instant with reduced motion. 3) In the existing FinalPass, with no new pass, add scotopic luminance V from linear RGB (Jensen et al. 2001 / Durand & Dorsey 2000). The output is mix(rgb, V·nightBlue, s), where s = mesopic weight(L_adapt) over 0.005–3 cd/m². nightBlue is about (0.80, 0.93, 1.30) and normalised. The mix is applied before tone mapping and weighted by skyBlend, so the globe-from-space view keeps its 'camera' look. Optionally, at full scotopic weight, the bloom mip is mixed in slightly to suggest the loss of acuity. 4) Replace the ad-hoc exposure curves (skyViewExposure, ECL_ADAPT) with the adapted luminance, so eclipses, twilight and moonlight share one model. Low tier (finalPass: false): apply a reduced version, the tint and desaturation through one uniform in the ground and sky shaders.

**Risks.** Night has to be readable without becoming a murky blue wash, which needs artistic tuning and A/B screenshots. It interacts with three other items: the sky lens's 'Your real sky' (luminance inputs), the ground-visibility quick win and the 'Night-vision red mode' (that red mode must bypass this). R6 holds because the change is in the existing final pass. The adapter state is scalar, so there is no per-frame allocation. Selected bodies and labels are DOM elements and are not affected.

**Files.** `js/astro/photometry.js`, `js/render/postfx.js`, `js/render/sky.js`, `js/render/ground.js`, `js/app/loop.js`, `test/astro.photometry.test.mjs`

**Verifier evidence.** sky.js:39 skyViewExposure(sunAlt, skyBlend, obscuration) and photometry.js:195 exposureFor(sunAlt, skyBlend) take no Moon input. ground.js:25 has ECL_ADAPT=0.4, and grep shows the ground shader has no moonlight term. postfx.js FINAL_FRAG has only vignette, tonemapping and dither. My check of skyground-fullmoon.png (Paris, mag −12.7 Moon at 58°) matches: vivid Milky Way, pure-black sky and ground. Grep finds no scotopic, purkinje or mesopic. quality.js:25 sets the low tier to finalPass:false.

**Verifier corrections.** The visible defect is physical, not perceptual. Moonlight does not brighten the sky or ground, and it does not suppress faint stars or the Milky Way. Lead with a Moon-aware term: Krisciunas–Schaefer sky brightness feeding exposureFor (limiting magnitude) and a moonlit sky/ground term in ground.glsl. After that, add a subtle Purkinje desaturation and tint in sky view only. Drop or minimise the 4 s 'dark adaptation'. It forces continuous rendering for seconds after every change (it must be added to loop.js's continuous flag, against render-on-demand), and stars fading back in after every scrub would read as a bug. Keep the ECL_ADAPT curve unless A/B screenshots show no regression, because ground.js:20-24 documents that it was tuned to stop a near-black dip before totality.

### `sky-soundscape`: Hear the sky: a generative, spatial soundscape that goes silent at totality

*feature · impact 4→2 · effort M→M · verdict **revise***

**Pitch.** Turn on sound and the sky hums. Each planet above the horizon is a soft voice, tuned by its orbital period and placed spatially where it sits around you, so Jupiter sounds from your left until you turn toward it. Daylight is a bright airy bed that sinks into a deep drone at dusk. At totality everything drops into a sudden hush and then a shimmering corona chord. In time-lapse you can hear a year as a slow tide of chords. It needs zero bytes of assets, and it doubles as an audio sky for blind visitors.

**Current state.** The app is completely silent: grepping for AudioContext or audio in js/, css/ and index.html returns nothing. The data that could drive sound already exists. The 4 Hz 'readout' bus event carries the full snapshot (CLAUDE.md, loop.js), including per-body altDeg, azDeg, mag and above, observer.sunAltDeg, twilight and eclipse.obscurationAtObserver (types.js:28-48). An aria-live announcer exists (js/ui/announcer.js), and prefs has a fixed key list (prefs.js:13) with no 'sound' key. Settings has Quality, Time display and View groups (settings.js:70-72).

**Proposal.** Add a pure core/sonify.js that maps a snapshot to voices, using only maths. Each body's frequency comes from a pentatonic quantisation of log(orbital period), so every mix is consonant. Gain is altitude above the horizon × a compressed 10^(−0.4·mag). Pan comes from azimuth relative to the camera heading. Bed brightness follows sun altitude, and the eclipse hush follows obscuration. js/ui/sound.js is the only file that touches WebAudio. It builds one fixed graph on the first user gesture: 9 oscillator pairs → per-voice gain → StereoPanner (HRTF PannerNode on the high tier) → a shared convolution-free reverb (feedback delay) → compressor. The noise bed is a looped AudioBuffer generated once and filtered by a biquad. Updates use AudioParam.setTargetAtTime at the 4 Hz readout, with no node creation per frame. Cues: a beam-launch whoosh during the intro, a selection chime in the body's own note, a sunrise swell, a hush at the second contact of a total eclipse followed by a pad, and a 'ping' as the camera's centre passes a body (the 'sky sonar' for screen-reader users, with pitch set by altitude). There is a speaker toggle in the topbar and a 'sound' pref that defaults to off; it pauses when the tab is hidden and follows prefers-reduced-motion for the whooshes. Because it lives in ui/ and reads only the bus, it works in text mode too.

**Risks.** Autoplay policy: the sound must start from a user gesture, and the default stays off. The music is subjective and can annoy, so it needs gentle defaults, a volume slider and a quick fade on toggle. Purity: sonify.js is pure maths, and WebAudio stays in ui/, so R1 and R3 hold. It adds about 6–10 KB of JavaScript to the module graph, which fits the tier budgets in check-size.mjs. The app must never claim the tuning is 'the real sound' of the planets; label it as a sonification.

**Files.** `js/core/sonify.js (new)`, `js/ui/sound.js (new)`, `js/ui/topbar.js`, `js/ui/settings.js`, `js/core/prefs.js`, `js/ui/index.js`, `test/core.sonify.test.mjs (new)`

**Verifier evidence.** A grep for AudioContext or audio in js/, css/ and index.html finds nothing (the only hit is --mute-audio in scripts/lib/chrome.mjs). prefs.js:13 PREF_KEYS has no 'sound', and unknown keys are accepted. settings.js:70-72 has the Quality, Time display and View groups. The 4 Hz readout (loop.js:265-272) fires only when sim time or the observer changes, not on camera turns. Camera heading is not in the store or on the bus: only bindUrl gets getCam via main.js:512.

**Verifier corrections.** Panning by 'azimuth relative to camera heading' cannot work from ui/ with the bus alone. The readout does not fire while the user looks around a paused sky. main.js would need to pass a getCam/heading accessor into the UI, the same pattern bindUrl uses. The 'sky sonar for blind visitors' claim is overstated without real design. Scope it to a gentle ambient bed plus event cues (sunrise swell, totality hush, selection chime), default off and labelled a sonification. Musical sound is subjective, and most visitors won't turn it on.

### `human-emissaries`: Beams to humanity's emissaries: Voyager 1 and 2, New Horizons and JWST, with 'a message sent now arrives tomorrow'

*feature · impact 4→4 · effort M→L · verdict **keep***

**Pitch.** Beside the nine worlds sit fainter, dashed 'radio' beams to the farthest things people ever built. Voyager 1 lies above Rasalhague in Ophiuchus, and a message sent now reaches it in 23 hours. Voyager 2 is so far south that only Canberra can talk to it, and a chip says 'Canberra is in contact right now'. JWST is a speck near the anti-Sun point. It turns the app's beam metaphor into the most moving fact in astronomy.

**Current state.** Only the nine natural bodies exist. BODIES is a fixed contract (bodies.js:4,36), and beams are a single InstancedBufferGeometry of 9 instances (beams.js:7-10,29). Grepping for voyager, jwst or spacecraft finds nothing. The body card already has a light-time sentence ('The light you see from Mars left 12 min 31 s ago', body-card.js:196-198), and its pattern carries over directly to one-way radio time.

**Proposal.** Add scripts/build-craft.mjs, which runs at build time like the existing npm run data. It pulls JPL Horizons heliocentric J2000 state vectors and writes data/craft.json (about 20–40 KB) with: Voyager 1 and 2 and Pioneer 10 and 11 (monthly samples from launch to about 2035, then linear asymptotic extrapolation, flagged 'projected'), New Horizons, and JWST (weekly samples 2022–2032, hidden outside that range). A pure js/astro/craft.js does cubic Hermite interpolation to get geocentric and topocentric directions, distance and one-way light time, plus 'which Deep Space Network complex can see it' (Goldstone, Madrid or Canberra horizon test). Rendering: a second, small instanced set in beams.js (or a sibling craft-beams.js) uses a thinner dashed 'radio' style and keeps BODIES untouched. A label kind 'craft' is added to labels-feed. The body card shows mission facts, launch date, speed, the radio time each way and the DSN chip. A layer toggle 'Spacecraft' defaults to on. A stretch goal is a 'Pale Blue Dot' moment (14 Feb 1990): the sky as seen from Voyager 1's position, with Earth as a fraction of a pixel in a scattered sunbeam. It reuses the vantage-point and Powers-of-Ten work from the motion lens.

**Risks.** The BODIES contract must not grow, so a parallel CRAFT list keeps the 1–9 keys and the beam instances unchanged. Extrapolating Voyager motion far beyond its data is linear and fine angularly, but must be labelled. JWST's halo orbit after 2032 is unknown, so it is hidden there. Horizons data is public, but the JPL/NASA credit must be added to the About credits. The runtime stays offline, and R4 holds because only the build script fetches.

**Files.** `scripts/build-craft.mjs (new)`, `data/craft.json (new)`, `js/astro/craft.js (new)`, `js/astro/snapshot.js`, `js/render/beams.js`, `js/app/labels-feed.js`, `js/ui/body-card.js`, `js/ui/layers.js`, `scripts/check-size.mjs`

**Verifier evidence.** A grep for voyager, jwst or spacecraft finds nothing. beams.js:7 has 24 segments × 9 instances, and :29 sets N = BODIES.length. Beams already carry light-time pulses (beams.js:2-4). body-card.js:196-198 holds the light-time sentence, as cited. url-state.js:16 BODY_IDS validates sel=, and bodies.js:4 makes BODIES order a contract. check-size counts only sky.json and cities.json among data files, so a lazily fetched craft.json does not hit the tier budgets. Timing: Voyager 1 reaches one light-day from Earth around November 2026, today's date, so 'a message sent now arrives tomorrow' is literally true now.

**Verifier corrections.** Effort is closer to L than M, because the selection contract has to grow. store.selection, the url-state BODY_IDS check, labels-feed and the body card all key on BodyId, so add a separate CRAFT id space (for example sel=v1). Monthly Voyager and Pioneer samples since 1977 plus weekly JWST samples will exceed 40 KB as plain JSON. Use adaptive sampling (dense near flybys, sparse on the cruise legs), Hermite interpolation with velocities and quantised integers, and add a FILE_BUDGETS entry. JWST needs topocentric parallax (up to about 0.24° at 1.5 Mkm). Word the DSN chip as 'in view of Canberra', not 'in contact', since that is a visibility test and not the DSN schedule.

### `two-observers`: Same sky, two places: a second pin whose beams converge on the Moon

*feature · impact 3→3 · effort L→L · verdict **revise***

**Pitch.** Add a friend's city and a second pin sprouts its own nine beams. The beams to the Sun and planets run parallel, but the two Moon beams visibly converge onto the Moon, which is parallax made visible: the measurement Lalande and Lacaille used in 1751 to find the Moon's distance from Berlin and the Cape. Split sky view shows the same Moon side by side, lit on the right in Paris and on the left in Sydney. Share it as 'look up, we're seeing the same Moon'.

**Current state.** The store holds exactly one observer (store.js, types.js:14-19), and the URL hash has a single loc key (url-state.js:26). beams.js draws one 9-instance strip from one origin (beams.js:7-10,29), and pin.js draws a single pin. computeSnapshot fills one preallocated Snapshot per observer chain. Nothing in the codebase compares two places, and none of the seven lenses proposed it.

**Proposal.** Add an optional observer2 slice (hash loc2, n2, tz2) and a second preallocated Snapshot computed at frame detail; computeSnapshot is pure, so this is a second call. On the globe: a second pin and a second beam instance set (an origin uniform per set, or the instance count raised to 18), each in its own city's accent colour. When both are set, an annotation draws the convergence angle at the Moon ('1.42° parallax → 384,400 km') and offers a 'Measure the Moon like Lalande, 1751' preset (Berlin and Cape Town). Sky view: a split mode renders the scene twice with renderer.setScissor and two viewports, swapping observer-dependent uniforms for ground, sky and labels between the passes, or uses picture-in-picture on narrow screens. Both halves use the same az/alt look, so the flipped Moon orientation between hemispheres is obvious. Sky now gets a two-column comparison (rise and set times in both zones). The share link carries both places.

**Risks.** Split sky view doubles the draw cost, so disable it on the low tier and fall back to toggling between the two places. Many modules assume one observer (labels-feed anchors, the footprint, the pin rings), so scope a first version to 'globe plus PiP sky'. The second Snapshot must be preallocated (R5). On the globe the Moon beams' convergence is only legible when the camera frames the Moon, so the preset must fly to a framing that shows it.

**Files.** `js/core/store.js`, `js/core/url-state.js`, `js/astro/snapshot.js`, `js/render/beams.js`, `js/render/pin.js`, `js/render/ground.js`, `js/render/labels.js`, `js/app/loop.js`, `js/main.js`, `js/ui/location.js`, `js/ui/sky-now.js`

**Verifier evidence.** store.js:36 DEFAULT_STATE has a single observer object. url-state.js:26 KNOWN_KEYS has one loc. beams.js:7 has one 9-instance strip from one origin. Grep finds no loc2 or observer2. postfx.js uses one EffectComposer with bloom over the full target, and ground.js, sky.js and labels hold per-observer uniforms.

**Verifier corrections.** Split sky view is the expensive and fragile part. The composer and bloom pass run over the whole target, so scissored viewports need two composer runs or bloom bleeding across the seam, and every observer-dependent uniform (ground zenith, altAz grid, labels, horizon) needs a swap between the passes. Ship globe-only first: a second pin, a second beam instance set and the parallax annotation. Then offer a 'switch place' toggle instead of a split. At true scale the Moon beams converge over about 60 Earth radii, which reads only at an Earth–Moon framing (about 100 ER, within MAX_DIST 150), so the preset must fly there.

### `idle-supersampling`: Progressive supersampling when idle: render-on-demand's spare frames turned into perfectly anti-aliased stills

*visual · impact 3→2 · effort M→M · verdict **revise***

**Pitch.** The moment you stop dragging, the image settles over about 150 ms. The Earth's limb, the hair-thin beams, the constellation lines and sub-pixel stars become as clean as an offline render, on every tier, phones included. The same machinery renders print-quality 2x or 4x postcards without allocating huge targets.

**Current state.** The loop draws only when the frame is dirty or something is animating (loop.js:309-312) and then idles, so the GPU sits unused exactly when the user is looking hardest at a still frame. Anti-aliasing varies by tier: low uses canvas antialias (context.js:78), and medium and high use 4x MSAA in a half-float target (quality.js TIERS, postfx.js:175-178). Thin additive geometry (beams, lines, glyph rings) still shimmers and steps, and the other lenses report aliasing on the phone limb. Grepping for jitter, accumul, supersampl or TAA in js/ finds no accumulation. Twinkle, the only continuous source in an idle sky view, is on only in the high tier (quality.js, twinkle: true).

**Proposal.** Add an accumulation step to postfx (allocated once, and again on resize, which satisfies R5): one RGBA16F target plus a tiny blend ShaderPass that ends with the R6 includes. When the loop finds nothing dirty and nothing continuous, it renders up to K extra frames (K = 8 on medium and low, 16 on high), each with a Halton(2,3) sub-pixel offset applied through camera.setViewOffset. Each frame is blended as a running average, acc = mix(acc, frame, 1/(k+1)), then bloom and the final pass run on the result. Any input, clock tick or invalidate resets k to 0 instantly, so interaction latency is unchanged. Pause accumulation while twinkle is active, or freeze twinkle's phase for its duration. Expose rc.renderStill({scale}) for the Sky Postcard and video items. It tiles the view with setViewOffset at 2x or 4x and accumulates each tile, so high-resolution export needs no giant render target. Low tier (no composer): accumulate into a small RGBA8 target instead, or skip K to 4.

**Risks.** DOM labels are not part of the accumulation, which is fine. Twinkle and the clock in Live mode keep things moving: at 1x the frame snapshot changes every 0.5 s of sim time, which would reset accumulation constantly, so accumulate between snapshot updates or let accumulation run through the 0.5 s steps. It adds GPU work after every settle, so cap it at K frames and then park, which fits the perf lens's battery item. Bloom on an accumulated input is fine. Without care the jitter could leak into picking, so apply the offset only inside the accumulation renders.

**Files.** `js/render/postfx.js`, `js/render/context.js`, `js/app/loop.js`, `js/core/quality.js`

**Verifier evidence.** loop.js:310-314 renders only when dirty or continuous. clock.js:533 is false at Live 1x, but loop.js:253-262 sets dirty on every 0.5 s snapshot step. context.js:78 sets antialias only on the low tier. quality.js:28,34 gives medium and high msaa 4, and quality.js:111 sets msaa=0 for coarse pointers on medium, so phones have no AA. My check of perfv-mobile-medium-far-crop-const.png shows a stair-stepped thin line. rig.js:759 already uses camera.setViewOffset for the UI-panel insets. Twinkle (high tier, sky view) is continuous (loop.js:310). Grep finds no jitter or accumulation in js/.

**Verifier corrections.** 1) camera.setViewOffset is already taken by rig.applyInsets (rig.js:749-760). Add the Halton offset to the inset offset, or jitter projectionMatrix.elements[8]/[9] directly and restore them, or the jitter will clobber the panel centring. 2) At Live 1x the snapshot sets dirty every 0.5 s. A hard reset to k=0 would make the image alternate between aliased and clean twice a second. When the camera is still and only sim time moved, keep the history and blend with an EMA, since the motion is sub-pixel. 3) Twinkle blocks accumulation on the high tier in sky view, so freeze twinkle's phase while accumulating. 4) The gain is real mainly on phones (coarse medium) and for postcard export. Desktop medium and high already have 4x MSAA, so impact is modest. Skip the low tier, which has canvas MSAA and no composer.

### `angle-ruler-and-fists`: Find it in the real sky: an angle ruler plus 'fists at arm's length' guidance

*ux-polish · impact 3→3 · effort S→M · verdict **keep***

**Pitch.** Shift-drag (or long-press) between any two things in sky view and an arc reads 'Moon → Jupiter 4.2°'. A translucent hand at the bottom shows what a fist (10°), three fingers (5°) and a little finger (1°) cover at the current zoom. The body card then says 'Jupiter: 3 fists above the east-north-east horizon, 2 fingers right of the Moon', which is the instruction amateur astronomers actually use outside.

**Current state.** Sky view can pick bodies and stars analytically (picking.js pickDir), and the camera's FOV ranges from 5° to 100° (rig.js:40-43). The body card gives alt/az and a compass arrow (README; body-card.js), and events.js reports separations for pairings and appulses (events.js:5-9, fmtSep). However, the user cannot measure an arbitrary angle, and nothing translates degrees into hand units: grepping for fist, ruler or arm's length finds nothing. The sky-view ground already covers the bottom 40% of the screen, which is natural space for the guide.

**Proposal.** 1) Ruler: in rig.js, Shift-drag or a long-press on touch enters measure mode. Both ends snap to the nearest body or star through pickDir within 18 px. The arc is a great-circle polyline from a preallocated createLineLayer (sky.js, the same helper trails.js uses), with a DOM label for the angle and the position angle. Esc clears it. Pure angle maths goes in frames.js or format.js. 2) A hand-scale overlay toggle draws a semi-transparent SVG hand anchored above the horizon. Its size is computed from the camera FOV and the viewport, so 10° always equals the fist, and it hides when FOV is under 15°. 3) Body card and Sky now get a 'How to find it' sentence from a pure helper in format.js that converts altitude to fists above the horizon and gives the nearest bright neighbour with an offset in fingers. 4) Teacher presets: 'Polaris' altitude equals your latitude' and 'Sun–Moon angle sets the phase'.

**Risks.** Gesture conflicts: long-press on touch competes with look-around, so it needs a threshold and haptic confirmation. Fist size varies between people, so label it '≈10°'. The ruler's DOM label must respect the label de-overlap system (labels.js uiOccluders). No rule conflicts: the line layer is preallocated and the maths is pure.

**Files.** `js/camera/rig.js`, `js/camera/picking.js`, `js/render/sky.js`, `js/render/labels.js`, `js/core/format.js`, `js/ui/body-card.js`, `js/ui/sky-now.js`, `js/ui/shortcuts.js`

**Verifier evidence.** A grep for fist, ruler or arm's length finds nothing. picking.js:139 has pickDir(ndc, camera, candidates, viewport, maxPx=18), as claimed. sky.js:111 exports createLineLayer, which trails.js:11,54 reuses. rig.js:40-42 sets SKY_FOV 70, MIN 5, MAX 100. Shift is used only for keyboard step size (rig.js:895), so Shift-drag is free. contextmenu is already prevented in sky mode (rig.js:886), which leaves long-press available.

**Verifier corrections.** Effort is M, not S. This adds a new gesture state to a 1179-line rig with drag, pinch and look-around, snapping, a great-circle polyline, a DOM label that has to join the uiOccluders de-overlap, an SVG hand overlay scaled by FOV and viewport, and a pure 'how to find it' helper (nearest bright neighbour, offsets in fingers) with tests. Keep the ruler's line layer preallocated with a fixed vertex count, and update it in place.

