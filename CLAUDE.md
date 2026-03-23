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

This is a single-page vanilla JS app using ES modules (no bundler). It renders an interactive 3D Earth globe and draws a line from a chosen observer location toward Mars based on real-time orbital calculations.

**Module dependency flow:**

```
index.html
  └── js/scene.js       — Three.js scene setup (renderer, camera, earth mesh, atmosphere shader, starfield, sun sprite)
  └── js/ui.js          — UI event handlers + core updateScene() logic + getUTCDate()
  └── js/animation.js   — Realtime and timelapse animation loop; hooks into state callbacks
        ├── js/astronomy.js  — Orbital mechanics (Kepler solver, heliocentric positions, GMST, lat/lon utils)
        ├── js/constants.js  — Shared math constants (DEG, J2000, AU conversions)
        ├── js/state.js      — Mutable scene object refs (markers, line, labels, animation state)
        └── js/scene.js      — Imports earth mesh, materials, sunLight for mutation
```

**Key rendering concepts:**
- Earth rotates via `earth.rotation.y = gmst(date)` to align with real sidereal time
- Mars direction is computed as a topocentric vector (geocentric position minus observer position in AU), accounting for light-travel time via two iterations
- The result is drawn as a white `THREE.Line` from the observer's world position outward, plus a blue cone marker indicating the Mars direction
- The atmosphere uses a custom GLSL shader with Fresnel + sun-scattering effects (additive blending, `depthWrite: false`), rendered on a slightly oversized sphere (radius 1.001)
- Post-processing uses `EffectComposer` → `RenderPass` + `UnrealBloomPass`

**Earth-lock camera mode:**
- A "Lock view to Earth" checkbox (enabled by default) makes the camera co-rotate with Earth's sidereal rotation
- Implemented entirely in the `animate()` loop in `index.html`: each frame, the delta of `earth.rotation.y` (GMST) is computed and applied to `camera.position` via `applyAxisAngle(Y_AXIS, delta)` before `controls.update()`

**Animation system:**
- `state.js` holds all animation state (`animMode`, `animPlaying`, `animRafHandle`, etc.) plus two callback hooks: `onMarkerSet` and `onExternalChange`
- `animation.js` registers those callbacks at init time; `ui.js` calls them when the location or date/timezone changes
- Two modes: `realtime` (wall-clock drives sim time from a base timestamp) and `timelapse` (interpolates between user-specified from/to dates over a fixed duration)

**Coordinate system note:** `latLonToVector3` in [js/astronomy.js](js/astronomy.js) maps lat/lon to a unit sphere where Three.js +Y = north pole. The equatorial observer position uses GMST + longitude as the hour angle. Two-step frame conversion is applied in `ui.js`: (1) ecliptic → standard equatorial via `applyAxisAngle(X, +OBLIQUITY)`; (2) equatorial (Z=north) → scene (Y=north) via the mapping `(x, y, z) → (x, z, -y)`. RA/Dec are computed in the equatorial frame; the rendered line and cone use the scene-frame vector.

**External dependencies (CDN only, no npm install):**
- Three.js `0.160.0` via unpkg importmap
- Bootstrap `5.3.3` for UI styling
- Nominatim (OpenStreetMap) for location geocoding
- Three.js hosted textures for earth day/night/normal maps