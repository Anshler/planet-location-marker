# Mars Location Marker
![License](https://img.shields.io/badge/license-MIT-blue)
![Vanilla JS](https://img.shields.io/badge/built%20with-Vanilla%20JS-f7df1e)
![No build step](https://img.shields.io/badge/build-none-brightgreen)
![Three.js](https://img.shields.io/badge/Three.js-0.160.0-black?logo=threedotjs)

An interactive 3D globe that shows the direction of Mars from any location on Earth, at any point in time.

## [→ Try it live](https://anshler.github.io/mars-location-marker/)

## Features

- 🔴 Real-time Mars direction from any Earth location
- 🌍 Interactive 3D globe with atmosphere & starfield
- 🕐 Timelapse animation across any date range
- 📡 Topocentric position with light-travel time correction

## Running Locally

```
npm start
```

Serves the app at `http://localhost:8080`. No build step required.

## About

Built with vanilla JavaScript and [Three.js](https://threejs.org/), no bundler, no framework. The app runs entirely in the browser as ES modules loaded directly from `index.html`.

Mars's position is computed from first principles using Kepler's equation to solve for the heliocentric orbital positions of Earth and Mars. The direction is then converted to a **topocentric vector**, accounting for the observer's exact position on Earth's surface, with two iterations of **light-travel time correction**, so the line points where Mars *was* when the light you'd see today left it.

Earth's orientation uses Greenwich Mean Sidereal Time (GMST) so the globe rotates to match the real sky at any given moment. The atmosphere glow is a custom GLSL shader with Fresnel and sun-scattering terms, rendered with additive blending. A bloom post-processing pass (Three.js `UnrealBloomPass`) adds the final glow.

_The orbital calculations are approximate, suitable for visualization, not navigation. If you spot a significant error in the math, please open an issue._

## For Developers

See [CLAUDE.md](CLAUDE.md) for architecture details, module structure, and rendering concepts.