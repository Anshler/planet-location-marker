# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

**Run locally:**
```
npm start
```
Serves the app at `http://localhost:8080` using `npx serve`. No build step — this is a pure ES module project loaded directly in the browser.

There are no tests or linting configured.

## Architecture

This is a single-page vanilla JS app using ES modules (no bundler). It renders an interactive 3D Earth globe and draws a direction line from a chosen observer location toward each tracked planet based on real-time orbital calculations.

**Module dependency flow:**

```
index.html
  └── js/scene.js       — Three.js scene setup (renderer, camera, earth mesh, atmosphere shader, starfield, sun sprite)
  └── js/ui.js          — UI event handlers + core updateScene() logic + getUTCDate()
  └── js/animation.js   — Realtime and timelapse animation loop; hooks into state callbacks
        ├── js/astronomy.js  — Orbital mechanics (Kepler solver, heliocentric positions, GMST, lat/lon utils)
        ├── js/planets.js    — Planet registry (PLANETS array + EARTH_ORBITAL coefficients)
        ├── js/constants.js  — Shared math constants (DEG, J2000, AU conversions)
        ├── js/state.js      — Mutable scene object refs (markers, line, labels, animation state)
        └── js/scene.js      — Imports earth mesh, materials, sunLight for mutation
```

**Planet system:**
- All tracked planets are defined in `js/planets.js` as a `PLANETS` array. Each entry is `{ name, color, orbital }` where `orbital` holds the six Kepler element coefficient pairs `[base, rate]`.

**Key rendering concepts:**
- Earth rotates via `earth.rotation.y = gmst(date)` to align with real sidereal time
- Each planet's direction is computed as a topocentric vector (geocentric position minus observer position in AU), accounting for light-travel time via two iterations
- Each planet is drawn as a `THREE.Line` from the observer's world position outward, plus a cone marker, using the planet's `color` field for both
- The atmosphere uses a custom GLSL shader with Fresnel + sun-scattering effects (additive blending, `depthWrite: false`), rendered on a slightly oversized sphere (radius 1.001)
- Post-processing uses `EffectComposer` → `RenderPass` + `UnrealBloomPass`

**Earth-lock camera mode:**
- A "Lock view to Earth" checkbox (enabled by default) makes the camera co-rotate with Earth's sidereal rotation
- Implemented entirely in the `animate()` loop in `index.html`: each frame, the delta of `earth.rotation.y` (GMST) is computed and applied to `camera.position` via `applyAxisAngle(Y_AXIS, delta)` before `controls.update()`

**Animation system:**
- `state.js` holds all animation state (`animMode`, `animPlaying`, `animRafHandle`, etc.) plus two callback hooks: `onMarkerSet` and `onExternalChange`
- `animation.js` registers those callbacks at init time; `ui.js` calls them when the location or date/timezone changes
- Two modes: `realtime` (wall-clock drives sim time from a base timestamp) and `timelapse` (interpolates between user-specified from/to dates over a fixed duration)

**Coordinate system note:** `latLonToVector3` in [js/astronomy.js](js/astronomy.js) maps lat/lon to a unit sphere where Three.js +Y = north pole. The equatorial observer position uses GMST + longitude as the hour angle. Two-step frame conversion is applied per planet in `ui.js`: (1) ecliptic → standard equatorial via `applyAxisAngle(X, +OBLIQUITY)`; (2) equatorial (Z=north) → scene (Y=north) via the mapping `(x, y, z) → (x, z, -y)`. RA/Dec are computed in the equatorial frame; the rendered line and cone use the scene-frame vector.

**External dependencies (CDN only, no npm install):**
- Three.js `0.160.0` via unpkg importmap
- Bootstrap `5.3.3` for UI styling
- Nominatim (OpenStreetMap) for location geocoding
- Three.js hosted textures for earth day/night/normal maps

## graphify

This project has a knowledge graph in `graphify-out/graph.json`.

**Before answering questions about codebase architecture, module relationships, or how components connect:** check the graph first using `/graphify query "<question>"`. The graph has pre-extracted relationships that are faster and more reliable than re-reading all files.

**After making code changes:** rebuild the graph to keep it current:
- Code-only changes: run `/graphify . --update` (AST only, no LLM cost)
- If you added/changed docs or comments: run `/graphify . --update` (will re-extract changed files)

**To explore the graph interactively:** open `graphify-out/graph.html` in a browser, or run `/graphify query "<question>"` to trace any concept through the graph.