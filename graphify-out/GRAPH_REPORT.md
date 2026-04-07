# Graph Report - .  (2026-04-07)

## Corpus Check
- Corpus is ~3,517 words - fits in a single context window. You may not need a graph.

## Summary
- 59 nodes · 95 edges · 14 communities detected
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.59)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `updateScene()` - 23 edges
2. `state Object (Mutable App State)` - 9 edges
3. `stopAnimation()` - 7 edges
4. `animLoop()` - 6 edges
5. `startAnimation()` - 6 edges
6. `heliocentricPosition()` - 6 edges
7. `gmst()` - 5 edges
8. `latLonToVector3()` - 5 edges
9. `formatForTimezone()` - 4 edges
10. `solveKepler()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `formatForTimezone()` --semantically_similar_to--> `parseDateTimeInTZ()`  [INFERRED] [semantically similar]
  js\animation.js → js\ui.js
- `Coordinate System Design Note` --rationale_for--> `updateScene()`  [EXTRACTED]
  CLAUDE.md → js\ui.js
- `Coordinate System Design Note` --rationale_for--> `latLonToVector3()`  [EXTRACTED]
  CLAUDE.md → js\astronomy.js
- `Topocentric Light-Travel Time Correction Rationale` --rationale_for--> `updateScene()`  [EXTRACTED]
  README.md → js\ui.js
- `Animation System Design Note` --rationale_for--> `state Object (Mutable App State)`  [EXTRACTED]
  CLAUDE.md → js/state.js

## Hyperedges (group relationships)
- **Planet Direction Rendering Pipeline** — ui_updatescene, astronomy_heliocentricposition, astronomy_heliocentricearthposition, planets_planets, scene_scene [EXTRACTED 0.95]
- **Animation State and Loop System** — state_state, animation_animloop, animation_startanimation, animation_stopanimation, animation_pauseanimation [EXTRACTED 0.95]
- **Kepler Orbital Mechanics Computation Chain** — astronomy_solvekepler, astronomy_orbitalelements, astronomy_heliocentricposition, constants_j2000, constants_deg [EXTRACTED 0.90]

## Communities

### Community 0 - "Animation Loop and Timing"
Cohesion: 0.3
Nodes (13): animLoop(), formatForTimezone(), getAnimDuration(), getSwappedRange(), handleExternalChange(), onModeChange(), pauseAnimation(), setMainPickerDisabled() (+5 more)

### Community 1 - "Orbital Mechanics Core"
Cohesion: 0.29
Nodes (11): gmst(), heliocentricEarthPosition(), heliocentricPosition(), julianDate(), normalizeAngleRad(), orbitalElements(), solveKepler(), DEG Constant (+3 more)

### Community 2 - "Physical Constants"
Cohesion: 0.33
Nodes (6): C_AU_PER_DAY Constant, EARTH_RADIUS_AU Constant, OBLIQUITY Constant, Topocentric Light-Travel Time Correction Rationale, DirectionalLight (Sun), updateScene()

### Community 3 - "3D Rendering Pipeline"
Cohesion: 0.4
Nodes (6): Earth-Lock Camera Mode Design, Perspective Camera, EffectComposer (Bloom Pipeline), OrbitControls, WebGL Renderer, Three.js Scene

### Community 4 - "Observer and Geocoding"
Cohesion: 0.5
Nodes (4): latLonToVector3(), Coordinate System Design Note, createLabel(), searchBtn onClick Handler

### Community 5 - "Date and Time UI"
Cohesion: 0.67
Nodes (2): getUTCDate(), parseDateTimeInTZ()

### Community 6 - "Planet Registry"
Cohesion: 0.67
Nodes (3): Planet System Architecture Note, PLANETS Array, No-Bundler Pure ES Module Design Rationale

### Community 7 - "Scene Setup"
Cohesion: 1.0
Nodes (0): 

### Community 8 - "Atmosphere Shader"
Cohesion: 1.0
Nodes (2): Atmosphere Shader Design Note, Atmosphere Shader Material

### Community 9 - "Earth Mesh"
Cohesion: 1.0
Nodes (2): Earth Mesh, Earth Material (MeshStandard)

### Community 10 - "Shared Math Constants"
Cohesion: 1.0
Nodes (0): 

### Community 11 - "Planets Module"
Cohesion: 1.0
Nodes (0): 

### Community 12 - "App State"
Cohesion: 1.0
Nodes (0): 

### Community 13 - "Sun Sprite"
Cohesion: 1.0
Nodes (1): createSunSprite Function

## Knowledge Gaps
- **12 isolated node(s):** `C_AU_PER_DAY Constant`, `OBLIQUITY Constant`, `EARTH_RADIUS_AU Constant`, `DirectionalLight (Sun)`, `Earth Material (MeshStandard)` (+7 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Scene Setup`** (2 nodes): `scene.js`, `createSunSprite()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Atmosphere Shader`** (2 nodes): `Atmosphere Shader Design Note`, `Atmosphere Shader Material`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Earth Mesh`** (2 nodes): `Earth Mesh`, `Earth Material (MeshStandard)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Shared Math Constants`** (1 nodes): `constants.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Planets Module`** (1 nodes): `planets.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `App State`** (1 nodes): `state.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Sun Sprite`** (1 nodes): `createSunSprite Function`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `updateScene()` connect `Physical Constants` to `Animation Loop and Timing`, `Orbital Mechanics Core`, `3D Rendering Pipeline`, `Observer and Geocoding`, `Date and Time UI`, `Planet Registry`, `Atmosphere Shader`, `Earth Mesh`?**
  _High betweenness centrality (0.646) - this node is a cross-community bridge._
- **Why does `Three.js Scene` connect `3D Rendering Pipeline` to `Physical Constants`?**
  _High betweenness centrality (0.142) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `stopAnimation()` (e.g. with `formatForTimezone()` and `onModeChange()`) actually correct?**
  _`stopAnimation()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `C_AU_PER_DAY Constant`, `OBLIQUITY Constant`, `EARTH_RADIUS_AU Constant` to the rest of the system?**
  _12 weakly-connected nodes found - possible documentation gaps or missing edges._