# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Planet Location Marker (v2): a static, no-build web app. It renders a real-time 3D Earth with a
beam from the observer to the Sun, the Moon and every planet, the true star sky, a sky view from
the ground, and astronomy computed in the browser by Astronomy Engine. It is deployed to GitHub Pages under
`/planet-location-marker/`.

## Development

```sh
npm start                     # node scripts/serve.mjs → http://localhost:8080 (no-store caching)
npm test                      # node --test "test/**/*.test.mjs" (zero dependencies)
npm run smoke                 # headless Chrome, every non-local host blocked, SPEC §H assertions
npm run size                  # transfer budgets per quality tier
npm run vendor                # re-fetch pinned vendor files, verify sha256 (vendor/VENDOR.json)
npm run data                  # rebuild data/sky.json, data/milkyway.png, data/cities.json from data/raw
```

- Node 22+ is needed for the tooling only.
- There are no npm dependencies, no bundler and no TypeScript.
- Run a single suite with `node --test "test/astro.*.test.mjs"`.

Useful smoke flags: `--url=/#t=2027-02-06T16:00:00Z&intro=0`, `--out=shot.png`, `--mobile`,
`--tz=UTC`, `--reduced-motion`, `--subpath=/planet-location-marker/`, `--eval="expr"` (awaited,
runs before the screenshot). Failure-matrix and intro checks: `--no-webgl`, `--init="js"` (before
the page's scripts), `--fail=data/sky.json` (forced 404s) and `--at=1000,3000` (timed shots). In
Git Bash, `export MSYS_NO_PATHCONV=1` first or `--url=/#…` is rewritten into a Windows path.

In the browser, `window.__app` exposes:

- `ready`, `version` and `tier`;
- `snapshot()`, the full-detail sky for the current instant;
- `stats()`, which returns fps, frames, draw calls, geometries, textures and beams/labels visible;
- `store`, `clock` and `actions`.

`#debug=1` shows the perf overlay. `#intro=0` skips the first-visit intro.

## Architecture

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the contributor guide, and
[docs/ASTRONOMY.md](docs/ASTRONOMY.md), which covers frames, formulas and the accuracy budget,
before larger changes.

```
index.html      import map (three → vendor/three), inline loader, feature detection, error capture
js/main.js      composition root: boot order, wiring, store→module subscriptions, window.__app
js/app/         actions (the UI's only API) · loop (render-on-demand) · labels-feed · intro · fallback
js/core/        store · bus · clock · url-state · quality (tiers, governor) · prefs · tz · format   [pure]
js/geo/         cities (offline) · geocode (online, optional) · coords                            [pure]
js/astro/       ae (astronomy-engine) · bodies · frames · snapshot · almanac · events · paths ·
                shadow · photometry · worker + client                                              [pure]
js/data/        catalog (sky.json decoder)                                                         [pure]
js/render/      context · postfx · textures · earth · atmosphere · sky · bodies · ground · beams ·
                pin · labels · trails · flare · debug        (three.js; loaded with dynamic import)
js/camera/      rig (orbit / sky view / Earth-lock / fly-to) · picking
js/ui/          DOM interface; talks to the app only via store, clock, actions
```

**Hard rules (tests enforce them):**

- **Pure modules.** `js/astro`, `js/core`, `js/geo` and `js/data` never import `three`, touch the
  DOM or use `window`. Only `core/prefs.js` touches `globalThis.localStorage`, and it is guarded.
  They import astronomy-engine only through `js/astro/ae.js`, by relative path.
- **Where three.js may appear.** Only `js/render`, `js/camera`, `js/main.js` and `js/app` import
  it. `js/ui` never imports `three` or `js/render`.
- **Static imports in `main.js`.** They must stay free of three.js. The UI and the render stack are
  `import()`ed, so text mode works without WebGL2 or import maps.
- **URLs.** All URLs are relative (`assets/…`, `data/…`). There are no external URLs outside
  `js/geo/geocode.js` and the About credits.
- **No per-frame allocation** of geometries, materials, textures or typed arrays. Reuse scratch
  objects.
- **Shaders.** Every custom `ShaderMaterial` fragment ends with `#include <tonemapping_fragment>`
  and `#include <colorspace_fragment>`.
- **Vectors and matrices.** Pure code uses `Float64Array(3)` vectors and row-major
  `Float64Array(9)` matrices. three.js gets column-major `Float64Array(16)`.
- **Clean console.** A healthy boot logs a single `console.info`. The smoke test fails on console
  errors.

**Key concepts:**

- **Scene frame.** +Y is the J2000 north pole, 1 unit is one Earth radius, and the Earth's centre
  is at the origin. EQJ maps to the scene with `S: (x, y, z) → (x, z, −y)`.
  - The sky (stars, constellations, Milky Way) is static.
  - The Earth is rotated by `earthMatrix = S·(PN·Rz(GAST))·Sᵀ`, recomputed per snapshot.
  - The equirectangular texture on three's `SphereGeometry` already matches the Earth-fixed frame.
- **Snapshots.** `computeSnapshot(t, observer, out, {detail})` fills a preallocated `Snapshot` in
  the scene frame.
  - `'frame'` detail drives rendering. It is recomputed when sim time moves 0.5 s or more, the
    observer changes or the clock jumps.
  - `'full'` detail, at 4 Hz, is published on the bus as `'readout'` for the panels.
- **Frame loop** (`js/app/loop.js`).
  - **Render on demand.** It draws only when something is dirty (`rc.invalidate()` → loop) or
    animating: camera motion, a clock tween or fast time, the intro, a held pointer, or twinkle.
  - **Strikes.** Every module call is guarded. Three failures hide that module.
  - **Governor.** The governor samples consecutive rendered frames only.
- **Render modules** implement `{object3d, apply(snap), update(fi), setLayers, setViewMode,
  setSelection, setQuality, dispose}`. `main.js` adds them to the scene, and they never add
  themselves. Add a new one in `importRenderStack()` and the `create(...)` list in `main.js`.
- **State.** `store` holds observer, selection, view, layers, display, quality, ui and status.
  `clock` owns simulated time (Live, the rate ladder, tweens, range loops, clamped to 1000–3000).
  The URL hash mirrors both (`core/url-state.js`, throttled `replaceState`).
- **Observer chain at boot.** URL hash, then saved prefs, then the largest city in the device
  timezone (canonical `byTz`), then Greenwich. Clicked points take the timezone and name of the
  nearest city within 300 km, otherwise an approximate `Etc/GMT±n` zone.
- **Quality.** There are three tiers (low, medium and high) and a downgrade-only governor (DPR
  first, then tier). Tiers switch in place: `rc.setTier`, then each module's `setQuality`, then the
  tier's textures.
- **Failure handling.**
  - No WebGL2 or no import maps gives text mode with a banner.
  - Context loss pauses rendering behind an overlay, then restores.
  - Missing textures or catalog keep placeholders and show a toast.
  - Boot errors end on the inline loader's error panel, never a blank page.

## graphify

This project has a knowledge graph in `graphify-out/graph.json`.

**Before answering questions about codebase architecture, module relationships, or how components connect:** check the graph first using `/graphify query "<question>"`. The graph has pre-extracted relationships that are faster and more reliable than re-reading all files.

**After making code changes:** rebuild the graph to keep it current:
- Code-only changes: run `/graphify . --update` (AST only, no LLM cost)
- If you added/changed docs or comments: run `/graphify . --update` (will re-extract changed files)

**To explore the graph interactively:** open `graphify-out/graph.html` in a browser, or run `/graphify query "<question>"` to trace any concept through the graph.