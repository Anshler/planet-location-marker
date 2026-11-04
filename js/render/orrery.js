/**
 * The orrery of the solar-system zoom (ROADMAP orrery-zoom-out, 'powers of ten'): zoomed out past
 * 80 R the globe fades into a live map of the solar system to scale (astro/orrery.js), each beam
 * continuing as the line from the Earth to its body.
 *
 * Its own scene and camera, in astronomical units with the Sun at the origin, drawn over the
 * main scene with its depth cleared (rc.setOverlay; main.js registers `scene` and `camera`): no
 * depth buffer could hold the Earth's 0.006 R cloud gap and Neptune's 30 AU at once. The camera
 * is the globe camera mapped across (position earthS + p / AU_ER, same orientation and projection),
 * so the Earth's dot sits exactly on the shrinking globe and is drawn at its true size until that
 * falls below a minimum. Nothing here writes or tests depth: orbits, then the sight lines, then the
 * Sun and the body sprites, in render order.
 *
 *  - Orbits: one period of each planet's orbit and the Moon's (the worker's 'orbits' op, sampled
 *    once and again only when sim time moves a century away), preallocated line segments.
 *  - Sight lines: from the Earth's centre to each body (snapshot helio.posS, so along its
 *    geocentric direction), continuing faintly past it; the beams fade into them (FrameInfo
 *    systemBlend). The Sun and Moon lines follow the Sun-and-Moon beams layer.
 *  - Bodies: point sprites lit by the Sun (phases), the Earth and Moon at their true size where
 *    that is larger; the Sun is bodies.glsl.js DISC_FRAG on a billboard (Medium and up) or a
 *    sprite (Low: lines and sprites only). Sizes are not to scale (the UI says so).
 *  - The retrograde figure: for a selected planet, its last SIGHT_COUNT sight lines at fixed
 *    sim-time steps (astro/orrery.js sightAt), fading with age, with the Earth's and the planet's
 *    positions at each step, run on to a backdrop and joined there: the curve folds back while
 *    the planet is retrograde (docs/ASTRONOMY.md §4).
 *  - Edge arrows: a body off the free area gets a chevron where its sight line leaves that area
 *    (astro/orrery.js edgeExit), pointing along it; its label sits there (labelPoint), as a
 *    beam's label sits where the beam leaves the screen.
 *
 * Labels: `labelPoint(id)` (a body, or 'earth') is a live point in the globe scene (Earth radii)
 * that the globe camera projects onto the body's sprite, or its arrow; NaN while hidden.
 * `labelOffset(id)` puts the label's dot just outside the sprite. `pick(ndcX, ndcY)` finds the
 * sprite or arrow under a click.
 *
 * No per-frame allocation (R5): every buffer and scratch object is created once.
 *
 * @module render/orrery
 */
import * as THREE from 'three';
import { BODIES, BODY_INDEX, AU_ER, AU_KM } from '../astro/bodies.js';
import { ORBIT_IDS, SIGHT_COUNT, sightStepMs, sightAt, edgeExit } from '../astro/orrery.js';
import { DISC_FRAG } from './shaders/bodies.glsl.js';
import { SPRITE_VERT, SPRITE_FRAG, SUN_VERT, ARROW_VERT, ARROW_FRAG } from './shaders/orrery.glsl.js';

const N = BODIES.length;
const SUN = BODY_INDEX.sun;
const MOON = BODY_INDEX.moon;
const EARTH = N;                 // sprite slot of the Earth
const RING = N + 1;              // the selection ring
const SLOTS = N + 2;
const DEG = Math.PI / 180;
const EARTH_COLOR = '#7cc4ff';
/** Minimum sprite radius, CSS px, by BODIES index (the Earth separately): enlarged, not to scale. */
const MIN_PX = Object.freeze([4, 1.6, 2.2, 3, 2.8, 5, 4.6, 3.6, 3.6]);
const EARTH_MIN_PX = 3.4;
/** Sight-line continuation past each body, AU (+ a share of its distance); none past the Sun. */
const EXT_AU = 1.5;
const EXT_K = 0.3;
const MOON_EXT_AU = 0.01;
const LINE_GAIN = 1.4;
/**
 * The retrograde figure: brightness of the newest sight line, and of the 'background' curve through
 * the lines' far ends, all FAN_FAR × the farthest Earth–planet distance from their Earth (the
 * textbook figure's distant backdrop, where the turn-back shows as a fold).
 */
const FAN_GAIN = 0.2;
const FAN_FAR = 2.5;
const FAN_CURVE_GAIN = 1.1;
const ORBIT_GAIN = 0.5;
/** Orbits are re-sampled when sim time is this far from their centre (a century). */
const ORBIT_REFRESH_MS = 100 * 365.25 * 864e5;
const ORBIT_RETRY_MS = 30000;
/** The globe Sun's look in orbit view (render/bodies.js), so the hand-over does not show. */
const SUN_HDR = 30;
const SUN_CORE = [1.0, 0.95, 0.85];
const SUN_GLOW = [1.0, 0.86, 0.66];
const SUN_GLOW_RAD = 0.8 * DEG;
const SUN_QUAD_RAD = 6 * DEG;
const SUN_MIN_PX = 3;
const SUN_KM = BODIES[SUN].radiusKm;
/**
 * Edge arrows sit this far inside the free area (CSS px): clear of the top bar, and room on the right
 * for the label, which runs right of its dot.
 */
const EDGE_PAD = Object.freeze({ left: 26, right: 96, top: 80, bottom: 34 });
const PICK_PX = 14;
/** The Moon's label goes while its dot is this close to the Earth's on screen (CSS px). */
const MOON_LABEL_SEP_PX = 16;
const PREMULT = {
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};
const NO_DEPTH = { transparent: true, depthTest: false, depthWrite: false };

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

/**
 * Creates the orrery module.
 * @param {object} rc RenderContext
 * @param {{requestOrbits?:(centerMs:number)=>Promise<{centerMs:number, n:number, nMoon:number, ids:string[],
 *   points:Float32Array, moon:Float32Array}>}} [deps] the worker's 'orbits' op
 * @returns {object} RenderModule & {scene, camera, labelPoint(id), labelOffset(id), pick(ndcX, ndcY), shown}
 */
export function createOrrery(rc, deps = {}) {
    const requestOrbits = typeof deps.requestOrbits === 'function' ? deps.requestOrbits : null;
    const group = new THREE.Group();     // the module's object3d in the main scene: empty
    group.name = 'orrery';
    const scene = new THREE.Scene();
    scene.name = 'orrery';
    scene.visible = false;
    const camera = new THREE.PerspectiveCamera(45, 1, 1e-6, 1000);
    camera.name = 'orrery.camera';

    const linColors = BODIES.map((b) => new THREE.Color(b.color));
    const earthColor = new THREE.Color(EARTH_COLOR);
    let lowTier = rc?.tier?.name === 'low';
    let layers = { beams: true, sunMoonBeams: true };
    let selected = -1;
    let hasSnap = false;
    let blend = 0;
    let lastT = NaN;
    const earthS = new Float64Array([1, 0, 0]);
    const posS = new Float64Array(3 * N);

    // ---- orbits ---------------------------------------------------------------------------------
    const NO = ORBIT_IDS.length;
    let orbitN = 0;
    let orbitCenter = NaN;
    let orbitPending = false;
    let orbitFailedAt = -Infinity;
    const orbitGeo = new THREE.BufferGeometry();
    const orbitMat = new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, ...NO_DEPTH });
    orbitMat.name = 'orrery.orbits';
    const orbits = new THREE.LineSegments(orbitGeo, orbitMat);
    orbits.name = 'orrery.orbits';
    orbits.frustumCulled = false;
    orbits.visible = false;
    orbits.renderOrder = 0;
    scene.add(orbits);
    const moonGeo = new THREE.BufferGeometry();
    const moonMat = new THREE.LineBasicMaterial({ color: linColors[MOON].clone().multiplyScalar(0.5), blending: THREE.AdditiveBlending, ...NO_DEPTH });
    moonMat.name = 'orrery.moonOrbit';
    const moonOrbit = new THREE.LineLoop(moonGeo, moonMat);
    moonOrbit.name = 'orrery.moonOrbit';
    moonOrbit.frustumCulled = false;
    moonOrbit.visible = false;
    scene.add(moonOrbit);

    function colorOrbits() {
        const a = orbitGeo.getAttribute('color');
        if (!a) return;
        for (let b = 0; b < NO; b++) {
            const id = ORBIT_IDS[b];
            const c = id === 'earth' ? earthColor : linColors[BODY_INDEX[id]];
            const g = ORBIT_GAIN * (BODY_INDEX[id] === selected ? 2.2 : 1);
            for (let i = 0; i < orbitN; i++) {
                const j = (b * orbitN + i) * 3;
                a.array[j] = c.r * g; a.array[j + 1] = c.g * g; a.array[j + 2] = c.b * g;
            }
        }
        a.needsUpdate = true;
    }

    function installOrbits(res) {
        if (!res || !(res.points instanceof Float32Array) || !Array.isArray(res.ids) || res.ids.length !== NO) return;
        const n = res.n;
        if (res.points.length !== NO * n * 3) return;
        if (n !== orbitN) {
            // Allocated once per sample count (in practice once): positions, colours, the loop index.
            orbitN = n;
            orbitGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NO * n * 3), 3));
            orbitGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(NO * n * 3), 3));
            const idx = new Uint32Array(NO * n * 2);
            for (let b = 0; b < NO; b++) {
                for (let i = 0; i < n; i++) {
                    idx[(b * n + i) * 2] = b * n + i;
                    idx[(b * n + i) * 2 + 1] = b * n + ((i + 1) % n);
                }
            }
            orbitGeo.setIndex(new THREE.BufferAttribute(idx, 1));
            colorOrbits();
        }
        const pa = orbitGeo.getAttribute('position');
        pa.array.set(res.points);
        pa.needsUpdate = true;
        if (res.moon instanceof Float32Array && res.moon.length >= 24) {
            let ma = moonGeo.getAttribute('position');
            if (!ma || ma.array.length !== res.moon.length) {
                ma = new THREE.BufferAttribute(new Float32Array(res.moon.length), 3);
                moonGeo.setAttribute('position', ma);
            }
            ma.array.set(res.moon);
            ma.needsUpdate = true;
            moonGeo.computeBoundingSphere();
        }
        orbitGeo.computeBoundingSphere();
        orbitCenter = res.centerMs;
        orbits.visible = true;
        moonOrbit.visible = true;
        rc?.invalidate?.();
    }

    function maybeRequestOrbits(tMs) {
        if (!requestOrbits || orbitPending || !Number.isFinite(tMs)) return;
        if (Number.isFinite(orbitCenter) && Math.abs(tMs - orbitCenter) < ORBIT_REFRESH_MS) return;
        const wall = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (wall - orbitFailedAt < ORBIT_RETRY_MS) return;
        orbitPending = true;
        Promise.resolve().then(() => requestOrbits(tMs)).then((res) => {
            orbitPending = false;
            installOrbits(res);
        }, (err) => {
            orbitPending = false;
            orbitFailedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
            console.warn('[orrery] orbits unavailable', err);
        });
    }

    // ---- sight lines (Earth → body, continuing past it) ------------------------------------------
    const lineGeo = new THREE.BufferGeometry();
    const linePos = new THREE.BufferAttribute(new Float32Array(N * 4 * 3), 3);
    const lineCol = new THREE.BufferAttribute(new Float32Array(N * 4 * 3), 3);
    linePos.setUsage(THREE.DynamicDrawUsage);
    lineCol.setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute('position', linePos);
    lineGeo.setAttribute('color', lineCol);
    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, ...NO_DEPTH });
    lineMat.name = 'orrery.lines';
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    lines.name = 'orrery.lines';
    lines.frustumCulled = false;
    lines.renderOrder = 2;
    scene.add(lines);

    function writeLines() {
        const p = linePos.array, c = lineCol.array;
        for (let i = 0; i < N; i++) {
            const j = i * 12;
            const on = layers.beams && (layers.sunMoonBeams || (i !== SUN && i !== MOON));
            const ex = earthS[0], ey = earthS[1], ez = earthS[2];
            const px = posS[i * 3], py = posS[i * 3 + 1], pz = posS[i * 3 + 2];
            const dx = px - ex, dy = py - ey, dz = pz - ez;
            const d = Math.hypot(dx, dy, dz) || 1;
            const ext = i === SUN ? 0 : i === MOON ? MOON_EXT_AU : EXT_AU + EXT_K * d;
            p[j] = ex; p[j + 1] = ey; p[j + 2] = ez;
            p[j + 3] = px; p[j + 4] = py; p[j + 5] = pz;
            p[j + 6] = px; p[j + 7] = py; p[j + 8] = pz;
            p[j + 9] = px + dx / d * ext; p[j + 10] = py + dy / d * ext; p[j + 11] = pz + dz / d * ext;
            const col = linColors[i];
            const g = on ? LINE_GAIN * (i === selected ? 1.6 : 1) : 0;
            for (let v = 0; v < 4; v++) {
                const k = v < 2 ? g : v === 2 ? 0.5 * g : 0;
                c[j + v * 3] = col.r * k; c[j + v * 3 + 1] = col.g * k; c[j + v * 3 + 2] = col.b * k;
            }
        }
        linePos.needsUpdate = true;
        lineCol.needsUpdate = true;
    }

    // ---- the retrograde figure (the selected planet's past sight lines) -------------------------
    const FAN = SIGHT_COUNT;
    const fanData = new Float64Array(FAN * 6);
    let fanBody = -1;
    let fanK0 = NaN;
    let fanFilled = 0;
    const fanGeo = new THREE.BufferGeometry();
    // Per line: Earth → planet → far end (4 vertices); then the far-end curve (FAN − 1 segments).
    const FAN_V = FAN * 4 + (FAN - 1) * 2;
    const fanPos = new THREE.BufferAttribute(new Float32Array(FAN_V * 3), 3);
    const fanCol = new THREE.BufferAttribute(new Float32Array(FAN_V * 3), 3);
    fanPos.setUsage(THREE.DynamicDrawUsage);
    fanCol.setUsage(THREE.DynamicDrawUsage);
    fanGeo.setAttribute('position', fanPos);
    fanGeo.setAttribute('color', fanCol);
    const fanMat = new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, ...NO_DEPTH });
    fanMat.name = 'orrery.fan';
    const fan = new THREE.LineSegments(fanGeo, fanMat);
    fan.name = 'orrery.fan';
    fan.frustumCulled = false;
    fan.visible = false;
    fan.renderOrder = 1;
    scene.add(fan);

    /** Recomputes the figure when the selection or the sim-time step changes (a few AE calls a step). */
    function updateFan(tMs) {
        const i = selected >= 2 ? selected : -1;
        if (i < 0 || !Number.isFinite(tMs)) {
            fan.visible = fanDots.visible = false;
            fanBody = -1;
            return;
        }
        const name = BODIES[i].ae;
        const step = sightStepMs(name);
        if (!Number.isFinite(step)) return;
        const k0 = Math.floor(tMs / step);
        if (i === fanBody && k0 === fanK0) return;
        const shift = i === fanBody && Number.isFinite(fanK0) ? k0 - fanK0 : FAN;
        if (shift > 0 && shift < FAN) {
            fanData.copyWithin(shift * 6, 0, (FAN - shift) * 6);
            for (let k = 0; k < shift; k++) sightAt(name, (k0 - k) * step, fanData, k * 6);
        } else if (shift < 0 && -shift < FAN) {
            fanData.copyWithin(0, -shift * 6, FAN * 6);
            for (let k = FAN + shift; k < FAN; k++) sightAt(name, (k0 - k) * step, fanData, k * 6);
        } else {
            for (let k = 0; k < FAN; k++) sightAt(name, (k0 - k) * step, fanData, k * 6);
        }
        fanBody = i;
        fanK0 = k0;
        fanFilled = FAN;
        writeFan();
    }

    function writeFan() {
        const p = fanPos.array, c = fanCol.array;
        const dp = dotPos.array, dc = dotCol.array, ds = dotSize.array, da = dotAlpha.array;
        const col = linColors[fanBody];
        let far = 0;
        for (let k = 0; k < FAN; k++) {
            const s = k * 6;
            far = Math.max(far, Math.hypot(fanData[s + 3] - fanData[s], fanData[s + 4] - fanData[s + 1], fanData[s + 5] - fanData[s + 2]));
        }
        far *= FAN_FAR;
        const cb = FAN * 12;
        for (let k = 0; k < FAN; k++) {
            const s = k * 6, j = k * 12;
            const ex = fanData[s], ey = fanData[s + 1], ez = fanData[s + 2];
            const px = fanData[s + 3], py = fanData[s + 4], pz = fanData[s + 5];
            const dx = px - ex, dy = py - ey, dz = pz - ez;
            const d = Math.hypot(dx, dy, dz) || 1;
            const fx = ex + dx / d * far, fy = ey + dy / d * far, fz = ez + dz / d * far;
            p[j] = ex; p[j + 1] = ey; p[j + 2] = ez;
            p[j + 3] = px; p[j + 4] = py; p[j + 5] = pz;
            p[j + 6] = px; p[j + 7] = py; p[j + 8] = pz;
            p[j + 9] = fx; p[j + 10] = fy; p[j + 11] = fz;
            const age = k < fanFilled ? Math.pow(1 - k / FAN, 1.5) : 0;
            // The far-end curve: this line's end to the next older one's.
            if (k > 0) {
                const q = cb + (k - 1) * 6;
                p[q] = p[j - 3]; p[q + 1] = p[j - 2]; p[q + 2] = p[j - 1];
                p[q + 3] = fx; p[q + 4] = fy; p[q + 5] = fz;
                const g0 = FAN_CURVE_GAIN * Math.pow(1 - (k - 1) / FAN, 1.5), g1 = FAN_CURVE_GAIN * age;
                c[q] = col.r * g0; c[q + 1] = col.g * g0; c[q + 2] = col.b * g0;
                c[q + 3] = col.r * g1; c[q + 4] = col.g * g1; c[q + 5] = col.b * g1;
            }
            for (let v = 0; v < 4; v++) {
                const g = FAN_GAIN * age * (v < 2 ? 1 : v === 2 ? 0.6 : 0.15);
                c[j + v * 3] = col.r * g; c[j + v * 3 + 1] = col.g * g; c[j + v * 3 + 2] = col.b * g;
            }
            // The positions at each step: the Earth's in its colour, the planet's in its own.
            for (let e = 0; e < 2; e++) {
                const q = (k * 2 + e) * 3, src = e === 0 ? earthColor : col;
                dp[q] = e === 0 ? ex : px; dp[q + 1] = e === 0 ? ey : py; dp[q + 2] = e === 0 ? ez : pz;
                dc[q] = src.r; dc[q + 1] = src.g; dc[q + 2] = src.b;
                ds[k * 2 + e] = 1.3;
                da[k * 2 + e] = 0.85 * age;
            }
        }
        fanPos.needsUpdate = fanCol.needsUpdate = true;
        dotPos.needsUpdate = dotCol.needsUpdate = dotSize.needsUpdate = dotAlpha.needsUpdate = true;
        fan.visible = fanDots.visible = true;
    }

    // ---- sprites -----------------------------------------------------------------------------------
    const spriteUniforms = { uDpr: { value: 1 } };
    const spriteMat = new THREE.ShaderMaterial({
        name: 'orrery.sprites', uniforms: spriteUniforms, vertexShader: SPRITE_VERT, fragmentShader: SPRITE_FRAG,
        ...NO_DEPTH, ...PREMULT,
    });
    const spriteGeo = new THREE.BufferGeometry();
    const sPos = new THREE.BufferAttribute(new Float32Array(SLOTS * 3), 3);
    const sCol = new THREE.BufferAttribute(new Float32Array(SLOTS * 3), 3);
    const sSize = new THREE.BufferAttribute(new Float32Array(SLOTS), 1);
    const sKind = new THREE.BufferAttribute(new Float32Array(SLOTS), 1);
    const sAlpha = new THREE.BufferAttribute(new Float32Array(SLOTS), 1);
    for (const a of [sPos, sSize, sAlpha, sCol]) a.setUsage(THREE.DynamicDrawUsage);
    spriteGeo.setAttribute('position', sPos);
    spriteGeo.setAttribute('aColor', sCol);
    spriteGeo.setAttribute('aSize', sSize);
    spriteGeo.setAttribute('aKind', sKind);
    spriteGeo.setAttribute('aAlpha', sAlpha);
    for (let i = 0; i < N; i++) {
        const c = linColors[i];
        sCol.array[i * 3] = c.r; sCol.array[i * 3 + 1] = c.g; sCol.array[i * 3 + 2] = c.b;
    }
    sCol.array[EARTH * 3] = earthColor.r; sCol.array[EARTH * 3 + 1] = earthColor.g; sCol.array[EARTH * 3 + 2] = earthColor.b;
    sKind.array[SUN] = 1;
    sKind.array[RING] = 2;
    const sprites = new THREE.Points(spriteGeo, spriteMat);
    sprites.name = 'orrery.sprites';
    sprites.frustumCulled = false;
    sprites.renderOrder = 4;
    scene.add(sprites);

    const dotGeo = new THREE.BufferGeometry();
    const dotPos = new THREE.BufferAttribute(new Float32Array(FAN * 2 * 3), 3);
    const dotCol = new THREE.BufferAttribute(new Float32Array(FAN * 2 * 3), 3);
    const dotSize = new THREE.BufferAttribute(new Float32Array(FAN * 2), 1);
    const dotKind = new THREE.BufferAttribute(new Float32Array(FAN * 2).fill(1), 1);
    const dotAlpha = new THREE.BufferAttribute(new Float32Array(FAN * 2), 1);
    for (const a of [dotPos, dotCol, dotSize, dotAlpha]) a.setUsage(THREE.DynamicDrawUsage);
    dotGeo.setAttribute('position', dotPos);
    dotGeo.setAttribute('aColor', dotCol);
    dotGeo.setAttribute('aSize', dotSize);
    dotGeo.setAttribute('aKind', dotKind);
    dotGeo.setAttribute('aAlpha', dotAlpha);
    const fanDots = new THREE.Points(dotGeo, spriteMat);
    fanDots.name = 'orrery.fanDots';
    fanDots.frustumCulled = false;
    fanDots.visible = false;
    fanDots.renderOrder = 1;
    scene.add(fanDots);

    // ---- the Sun (Medium and up): the bodies' disc shader on a billboard -------------------------
    const sunUniforms = {
        uCenter: { value: new THREE.Vector3(0, 0, 0) },
        uHalfPx: { value: 100 },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uTanR: { value: 100 },
        uCoreR: { value: 4 },
        uEdge: { value: 1 },
        uCoreColor: { value: new THREE.Color() },
        uGlowColor: { value: new THREE.Color() },
        uGlowScale: { value: 10 },
        uGlowGain: { value: 1.5 },
        uOcclude: { value: 0 },
        uRefrV: { value: new THREE.Vector4(0, 1, 0, 0) },
    };
    const sunQuad = new THREE.PlaneGeometry(2, 2);
    const sunMat = new THREE.ShaderMaterial({
        name: 'orrery.sun', uniforms: sunUniforms, vertexShader: SUN_VERT, fragmentShader: DISC_FRAG,
        ...NO_DEPTH, ...PREMULT,
    });
    const sun = new THREE.Mesh(sunQuad, sunMat);
    sun.name = 'orrery.sun';
    sun.frustumCulled = false;
    sun.renderOrder = 3;
    scene.add(sun);

    // ---- edge arrows -----------------------------------------------------------------------------------
    const arrowUniforms = { uDpr: { value: 1 } };
    const arrowMat = new THREE.ShaderMaterial({
        name: 'orrery.arrows', uniforms: arrowUniforms, vertexShader: ARROW_VERT, fragmentShader: ARROW_FRAG,
        ...NO_DEPTH, ...PREMULT,
    });
    const arrowGeo = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
    const aCol = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
    const aAng = new THREE.BufferAttribute(new Float32Array(N), 1);
    const aAlp = new THREE.BufferAttribute(new Float32Array(N), 1);
    for (const a of [aPos, aAng, aAlp]) a.setUsage(THREE.DynamicDrawUsage);
    arrowGeo.setAttribute('position', aPos);
    arrowGeo.setAttribute('aColor', aCol);
    arrowGeo.setAttribute('aAngle', aAng);
    arrowGeo.setAttribute('aAlpha', aAlp);
    for (let i = 0; i < N; i++) {
        const c = linColors[i];
        aCol.array[i * 3] = c.r * 1.2; aCol.array[i * 3 + 1] = c.g * 1.2; aCol.array[i * 3 + 2] = c.b * 1.2;
    }
    const arrows = new THREE.Points(arrowGeo, arrowMat);
    arrows.name = 'orrery.arrows';
    arrows.frustumCulled = false;
    arrows.renderOrder = 5;
    scene.add(arrows);

    // ---- labels and picking --------------------------------------------------------------------------
    /** Live label points in the globe scene (Earth radii), per BODIES index and the Earth (N). */
    const labelPts = Array.from({ length: N + 1 }, () => new Float64Array([NaN, NaN, NaN]));
    const labelOffs = Array.from({ length: N + 1 }, () => new Float64Array([7, -7]));
    /** Screen positions (CSS px) and pick radii of the sprites and arrows, from the last update. */
    const scr = new Float64Array((N + 1) * 3);
    const _size = new THREE.Vector2();
    const _v = new THREE.Vector3();
    const rect = { x0: -1, x1: 1, y0: -1, y1: 1, cx: 0, cy: 0, aspect: 1 };
    const edge = { x: 0, y: 0, angle: 0 };
    let cssW = 1, cssH = 1;

    function hideLabels() {
        for (let i = 0; i <= N; i++) labelPts[i][0] = labelPts[i][1] = labelPts[i][2] = NaN;
        for (let i = 0; i <= N; i++) scr[i * 3 + 2] = 0;
    }

    /** Clip coordinates of an orrery point (AU) with the orrery camera, into `clip`. */
    const clip = { X: 0, Y: 0, W: 0 };
    function project(x, y, z) {
        const m = camera.matrixWorldInverse.elements, p = camera.projectionMatrix.elements;
        const vx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const vy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const vz = m[2] * x + m[6] * y + m[10] * z + m[14];
        clip.X = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
        clip.Y = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
        clip.W = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
        return clip;
    }

    /** The globe camera mapped into the orrery: same pose and projection, AU, its own near/far. */
    function syncCamera(gc) {
        const k = 1 / AU_ER;
        camera.position.set(earthS[0] + gc.position.x * k, earthS[1] + gc.position.y * k, earthS[2] + gc.position.z * k);
        camera.quaternion.copy(gc.quaternion);
        camera.fov = gc.fov;
        camera.aspect = gc.aspect;
        camera.zoom = gc.zoom;
        const v = gc.view;
        if (v && v.enabled) camera.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height);
        else if (camera.view && camera.view.enabled) camera.clearViewOffset();
        const dE = gc.position.length();
        camera.near = Math.max(1e-9, 0.25 * Math.max(dE - 1, 1e-3) * k);
        camera.far = camera.position.length() + 200;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        return dE;
    }

    function readTier(cfg) {
        lowTier = (cfg?.name ?? rc?.tier?.name) === 'low';
    }

    // ---- RenderModule ------------------------------------------------------------------------------

    function apply(snap) {
        const h = snap && snap.helio;
        if (!h) return;
        earthS[0] = h.earthS[0]; earthS[1] = h.earthS[1]; earthS[2] = h.earthS[2];
        posS.set(h.posS);
        hasSnap = true;
        lastT = snap.tMs;
        const p = sPos.array;
        for (let i = 0; i < N; i++) {
            p[i * 3] = posS[i * 3]; p[i * 3 + 1] = posS[i * 3 + 1]; p[i * 3 + 2] = posS[i * 3 + 2];
        }
        p[EARTH * 3] = earthS[0]; p[EARTH * 3 + 1] = earthS[1]; p[EARTH * 3 + 2] = earthS[2];
        sPos.needsUpdate = true;
        moonOrbit.position.set(earthS[0], earthS[1], earthS[2]);
        writeLines();
        if (blend > 0) {
            maybeRequestOrbits(snap.tMs);
            updateFan(snap.tMs);
        }
    }

    function update(fi) {
        const k = fi && Number.isFinite(fi.systemBlend) ? clamp(fi.systemBlend, 0, 1) : 0;
        const gc = fi && fi.camera;
        const was = blend;
        blend = k;
        const on = k > 0.002 && hasSnap && !!gc;
        scene.visible = on;
        if (!on) { hideLabels(); return; }
        if (was <= 0) {
            maybeRequestOrbits(lastT);
            updateFan(lastT);
        }
        const r = rc && rc.renderer;
        let dpr = 1, W = 1, H = 1;
        if (r) {
            r.getDrawingBufferSize(_size);
            dpr = r.getPixelRatio() || 1;
            W = _size.x; H = _size.y;
        }
        cssW = W / dpr; cssH = H / dpr;
        spriteUniforms.uDpr.value = dpr;
        arrowUniforms.uDpr.value = dpr;
        const dE = syncCamera(gc);
        // Pixels per radian at the centre (CSS), from the globe camera's projection.
        const pxRad = 0.5 * cssH * gc.projectionMatrix.elements[5];

        // Fades: the lines and the orbits with the blend; the Earth and Moon dots later, so the
        // textured globe and the true-scale Moon stay in front while they are bigger than a dot.
        orbitMat.opacity = k;
        moonMat.opacity = k;
        lineMat.opacity = k;
        fanMat.opacity = k;
        const kDot = smooth(0.35, 1, k);
        const kArrow = smooth(0.5, 1, k);

        // The free area (CSS px → NDC) for the edge arrows.
        const ins = rc?.size?.insets ?? { left: 0, right: 0, top: 0, bottom: 0 };
        rect.x0 = -1 + 2 * (ins.left + EDGE_PAD.left) / cssW;
        rect.x1 = 1 - 2 * (ins.right + EDGE_PAD.right) / cssW;
        rect.y0 = -1 + 2 * (ins.bottom + EDGE_PAD.bottom) / cssH;
        rect.y1 = 1 - 2 * (ins.top + EDGE_PAD.top) / cssH;
        rect.cx = (-1 + 2 * ins.left / cssW + 1 - 2 * ins.right / cssW) / 2;
        rect.cy = (-1 + 2 * ins.bottom / cssH + 1 - 2 * ins.top / cssH) / 2;
        rect.aspect = cssW / cssH;

        const sz = sSize.array, al = sAlpha.array;
        const ap = aPos.array, aa = aAng.array, aal = aAlp.array;
        const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
        // The Earth on screen: where every sight line starts.
        project(earthS[0], earthS[1], earthS[2]);
        const eW = clip.W > 1e-12 ? clip.W : 1e-12;
        const eX = clip.X / eW, eY = clip.Y / eW;
        const camE = Math.hypot(earthS[0] - cx, earthS[1] - cy, earthS[2] - cz);
        for (let i = 0; i <= N; i++) {
            const isEarth = i === N;
            const x = isEarth ? earthS[0] : posS[i * 3], y = isEarth ? earthS[1] : posS[i * 3 + 1], z = isEarth ? earthS[2] : posS[i * 3 + 2];
            // True radius on screen where that is larger than the minimum (the Earth from the
            // globe camera's own distance, in Earth radii, so its dot matches the globe).
            let px;
            if (isEarth) px = Math.max(EARTH_MIN_PX, pxRad * Math.asin(Math.min(1, 1 / Math.max(dE, 1))));
            else {
                const dKm = Math.hypot(x - cx, y - cy, z - cz) * AU_KM;
                const trueR = dKm > 0 ? Math.asin(Math.min(1, BODIES[i].radiusKm / dKm)) : 0;
                px = Math.max(i === SUN ? SUN_MIN_PX : MIN_PX[i], pxRad * trueR);
            }
            const slot = isEarth ? EARTH : i;
            sz[slot] = px;
            const kBody = isEarth || i === MOON ? kDot : k;
            al[slot] = i === SUN && !lowTier ? 0 : kBody;
            if (i === SUN && lowTier) sz[slot] = Math.max(px, MIN_PX[SUN]);
            const off = labelOffs[i];
            off[0] = px + 3;
            off[1] = -(px + 3);
            // Screen place: on the sprite, or (off the free area) the arrow where its line leaves.
            project(x, y, z);
            const nx = clip.X / clip.W, ny = clip.Y / clip.W;
            const out = !(clip.W > 1e-12 && nx >= rect.x0 && nx <= rect.x1 && ny >= rect.y0 && ny <= rect.y1);
            const lp = labelPts[i];
            let exits = false;
            if (out && !isEarth && kArrow > 0) {
                // The line's direction on screen at the Earth: a point a little way along it.
                const dl = Math.hypot(x - earthS[0], y - earthS[1], z - earthS[2]) || 1;
                const f = Math.min(1, 0.02 * camE / dl);
                project(earthS[0] + (x - earthS[0]) * f, earthS[1] + (y - earthS[1]) * f, earthS[2] + (z - earthS[2]) * f);
                exits = clip.W > 1e-12 && edgeExit(eX, eY, clip.X / clip.W - eX, clip.Y / clip.W - eY, rect, edge);
            }
            if (exits) {
                ap[i * 3] = edge.x; ap[i * 3 + 1] = edge.y; ap[i * 3 + 2] = 0;
                aa[i] = edge.angle;
                aal[i] = kArrow;
                // The label: inward of the arrow, along the ray through it from the globe camera.
                _v.set(edge.x, edge.y, 0.5).unproject(gc).sub(gc.position).normalize();
                const L = Math.max(dE, 2);
                lp[0] = gc.position.x + _v.x * L; lp[1] = gc.position.y + _v.y * L; lp[2] = gc.position.z + _v.z * L;
                off[0] = -14 * Math.cos(edge.angle);
                off[1] = 14 * Math.sin(edge.angle);
                scr[i * 3] = (edge.x * 0.5 + 0.5) * cssW;
                scr[i * 3 + 1] = (0.5 - edge.y * 0.5) * cssH;
                scr[i * 3 + 2] = PICK_PX;
                continue;
            }
            if (!isEarth && i < N) aal[i] = 0;
            if (out) {
                lp[0] = lp[1] = lp[2] = NaN;
                scr[i * 3 + 2] = 0;
                continue;
            }
            scr[i * 3] = (nx * 0.5 + 0.5) * cssW;
            scr[i * 3 + 1] = (0.5 - ny * 0.5) * cssH;
            scr[i * 3 + 2] = Math.max(PICK_PX, px + 6);
            if (isEarth) {
                // A point on the Earth's near side: the label test against the unit sphere passes.
                const g = gc.position, gl = dE || 1;
                lp[0] = g.x / gl * 1.2; lp[1] = g.y / gl * 1.2; lp[2] = g.z / gl * 1.2;
            } else {
                lp[0] = (x - earthS[0]) * AU_ER; lp[1] = (y - earthS[1]) * AU_ER; lp[2] = (z - earthS[2]) * AU_ER;
            }
        }
        // The Moon's label goes while its dot sits on the Earth's.
        if (scr[MOON * 3 + 2] > 0 && scr[N * 3 + 2] > 0
            && Math.hypot(scr[MOON * 3] - scr[N * 3], scr[MOON * 3 + 1] - scr[N * 3 + 1]) < MOON_LABEL_SEP_PX) {
            const lp = labelPts[MOON];
            lp[0] = lp[1] = lp[2] = NaN;
            scr[MOON * 3 + 2] = 0;
        }
        // Selection ring.
        if (selected >= 0 && scr[selected * 3 + 2] > 0 && aal[selected] === 0) {
            const p = sPos.array;
            p[RING * 3] = p[selected * 3]; p[RING * 3 + 1] = p[selected * 3 + 1]; p[RING * 3 + 2] = p[selected * 3 + 2];
            sPos.needsUpdate = true;
            const c = linColors[selected];
            sCol.array[RING * 3] = 0.35 + 0.65 * c.r; sCol.array[RING * 3 + 1] = 0.35 + 0.65 * c.g; sCol.array[RING * 3 + 2] = 0.35 + 0.65 * c.b;
            sCol.needsUpdate = true;
            sz[RING] = (selected === SUN ? Math.max(sz[SUN], 6) : sz[selected]) + 5;
            al[RING] = 0.9 * k;
        } else {
            al[RING] = 0;
        }
        sSize.needsUpdate = sAlpha.needsUpdate = true;
        aPos.needsUpdate = aAng.needsUpdate = aAlp.needsUpdate = true;

        // The Sun's billboard (as render/bodies.js draws it in orbit view).
        sun.visible = !lowTier;
        if (!lowTier) {
            const pxDev = pxRad * dpr;
            const dSun = Math.hypot(cx, cy, cz) * AU_KM;
            const trueR = dSun > SUN_KM ? Math.asin(SUN_KM / dSun) : Math.PI / 2;
            const core = Math.max(trueR * pxDev, SUN_MIN_PX * dpr);
            // The glare shrinks and dims with the Sun's distance (gentler than the true 1 / d²), so the
            // whole inner system stays readable from a few AU out.
            const near = clamp(AU_KM / Math.max(dSun, 1), 0.12, 1);
            const reach = clamp(Math.sqrt(near), 0.35, 1);
            sunUniforms.uHalfPx.value = Math.max(SUN_QUAD_RAD * pxDev * reach, 4 * core);
            sunUniforms.uTanR.value = sunUniforms.uHalfPx.value;
            sunUniforms.uCoreR.value = core;
            sunUniforms.uEdge.value = dpr;
            sunUniforms.uGlowScale.value = SUN_GLOW_RAD * pxDev * reach;
            sunUniforms.uGlowGain.value = 1.5 * k * near;
            sunUniforms.uViewport.value.set(W, H);
            const c = SUN_HDR * k;
            sunUniforms.uCoreColor.value.setRGB(SUN_CORE[0] * c, SUN_CORE[1] * c, SUN_CORE[2] * c);
            sunUniforms.uGlowColor.value.setRGB(SUN_GLOW[0], SUN_GLOW[1], SUN_GLOW[2]);
        }
    }

    /**
     * The body (or 'earth') under a click, from the last drawn frame: the nearest sprite or edge
     * arrow within its pick radius.
     * @param {number} ndcX
     * @param {number} ndcY
     * @returns {string|null}
     */
    function pick(ndcX, ndcY) {
        if (!scene.visible || blend < 0.5) return null;
        const x = (ndcX * 0.5 + 0.5) * cssW, y = (0.5 - ndcY * 0.5) * cssH;
        let best = null, bestD = Infinity;
        for (let i = 0; i <= N; i++) {
            const r = scr[i * 3 + 2];
            if (!(r > 0)) continue;
            const d = Math.hypot(scr[i * 3] - x, scr[i * 3 + 1] - y);
            if (d <= r && d < bestD) { bestD = d; best = i === N ? 'earth' : BODIES[i].id; }
        }
        return best;
    }

    return {
        object3d: group,
        /** The overlay scene and its camera (main.js hands them to rc.setOverlay). */
        scene,
        camera,
        apply,
        update,
        pick,
        /** True while the orrery is drawn. */
        get shown() { return scene.visible; },
        /** @param {string} id body id or 'earth' @returns {Float64Array|null} live globe-scene point */
        labelPoint(id) {
            if (id === 'earth') return labelPts[N];
            const i = BODY_INDEX[id];
            return i === undefined ? null : labelPts[i];
        },
        /** @param {string} id @returns {Float64Array|null} live label offset, CSS px */
        labelOffset(id) {
            if (id === 'earth') return labelOffs[N];
            const i = BODY_INDEX[id];
            return i === undefined ? null : labelOffs[i];
        },
        setLayers(l) {
            if (!l) return;
            layers = { beams: l.beams !== false, sunMoonBeams: l.sunMoonBeams !== false };
            if (hasSnap) writeLines();
            rc?.invalidate?.();
        },
        setViewMode() {},
        setSelection(id) {
            const i = id == null ? -1 : BODY_INDEX[id] ?? -1;
            if (i === selected) return;
            selected = i;
            colorOrbits();
            if (hasSnap) writeLines();
            fanBody = -1;
            fanK0 = NaN;
            if (blend > 0) updateFan(lastT);
            else fan.visible = fanDots.visible = false;
            rc?.invalidate?.();
        },
        setQuality(cfg) {
            readTier(cfg);
            rc?.invalidate?.();
        },
        dispose() {
            for (const g of [orbitGeo, moonGeo, lineGeo, fanGeo, spriteGeo, dotGeo, sunQuad, arrowGeo]) g.dispose();
            for (const m of [orbitMat, moonMat, lineMat, fanMat, spriteMat, sunMat, arrowMat]) m.dispose();
        },
    };
}
