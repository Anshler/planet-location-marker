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

This is a single-page vanilla JS app using ES modules (no bundler). It renders an interactive 3D Earth globe and draws a line from the observer's location toward Mars based on real-time orbital calculations.

**Module dependency flow:**

```
index.html
  └── js/scene.js       — Three.js scene setup (renderer, camera, earth mesh, atmosphere shader, starfield)
  └── js/ui.js          — UI event handlers + core updateScene() logic
        ├── js/astronomy.js  — Orbital mechanics (Kepler solver, heliocentric positions, GMST, lat/lon utils)
        ├── js/constants.js  — Shared math constants (DEG, J2000, AU conversions)
        ├── js/state.js      — Mutable scene object refs (markers, line, current lat/lon)
        └── js/scene.js      — Imports earth mesh, materials, sunLight for mutation
```

**Key rendering concepts:**
- Earth rotates via `earth.rotation.y = -gmst(date)` to align with real sidereal time
- Mars direction is computed as a topocentric vector (geocentric position minus observer position in AU), accounting for light-travel time via two iterations
- The result is drawn as a white `THREE.Line` from the observer's world position outward, plus a blue sphere marker where the line exits the Earth
- The atmosphere uses a custom GLSL shader with Fresnel + sun-scattering effects (additive blending, `BackSide`)
- Post-processing uses `EffectComposer` → `RenderPass` + `UnrealBloomPass`

**External dependencies (CDN only, no npm install):**
- Three.js `0.160.0` via unpkg importmap
- Bootstrap `5.3.3` for UI styling
- Nominatim (OpenStreetMap) for location geocoding
- Three.js hosted textures for earth day/night/normal maps

**Coordinate system note:** `latLonToVector3` in [js/astronomy.js](js/astronomy.js) maps lat/lon to a unit sphere where Three.js +Y = north pole. The equatorial observer position uses GMST + longitude as the hour angle.
