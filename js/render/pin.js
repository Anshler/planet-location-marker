/**
 * Observer pin (SPEC §C.6): a glowing head (r 0.012) on a 0.05 spike along the
 * local vertical, a soft foot glow, a drop animation with a two-ring ripple,
 * and the horizon disc (layer `horizon`): CircleGeometry(0.22, 64) tangent at
 * the pin, alpha 0.18, N/E/S/W ticks drawn in-shader (north in red, like a
 * compass needle) plus faint 30° minor ticks.
 *
 * Everything is a child of a group whose matrix is `snap.earthMatrix`, so the
 * pin is placed once in Earth geometry-local coordinates and simply rides the
 * Earth's rotation.
 *
 * Draw order: the disc and ripple use renderOrder 29 (just before the beams)
 * and the disc writes depth, so beam segments below the horizon plane are
 * hidden by it in pass A and shown by the x-ray pass instead, which is what
 * the disc means. The head, spike and halo use renderOrder 40 (after beams).
 *
 * The pin body keeps a near-constant screen size: it scales with the camera's
 * distance to the pin (clamped), so it neither vanishes when zoomed out nor
 * fills the view when skimming the surface.
 *
 * Extras: `prime()` hides the pin until `drop()`; `cardinals` exposes live
 * world points at the disc's N/E/S/W rim for optional orbit-view labels.
 *
 * @module render/pin
 */
import * as THREE from 'three';
import { latLonToLocal, enuLocal } from '../astro/frames.js';

const HEAD_R = 0.012;
const SPIKE_H = 0.05;
const DISC_R = 0.22;
const DISC_LIFT = 0.0025;  // above the true sphere; > the 64-segment facet sagitta (0.0012)
const RIPPLE_LIFT = 0.003;
const RIPPLE_R = 0.16;     // max ripple radius at pin scale 1
const FALL_MS = 420;
const SETTLE_MS = 200;
const RIPPLE_MS = 1150;
const RIPPLE_STAGGER = 190;
const REF_DIST = 2.4;      // camera→pin distance at the default view, where the pin is drawn at scale 1
const HALO_SIZE = 0.07;    // halo quad size (view-space units) at pin scale 1

const ACCENT = new THREE.Color('#7cc4ff');
const NORTH = new THREE.Color('#ff5a4a');

function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function prefersReducedMotion() {
    try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

const easeInQuad = (t) => t * t;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

// ---- shaders -------------------------------------------------------------------------------------

const DISC_VERT = /* glsl */ `
varying vec2 vP;   // (east, north) / DISC_R
void main() {
    vP = vec2(position.x, -position.z) / ${DISC_R.toFixed(4)};
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DISC_FRAG = /* glsl */ `
#define PI 3.14159265359
uniform float uAlpha;
uniform vec3 uColor;
uniform vec3 uNorth;
varying vec2 vP;

// Angular tick mask with a constant linear width; ang is measured clockwise from north.
float ticks(float ang, float r, float period, float halfWidthLinear, float r0, float r1) {
    float d = abs(fract(ang / period + 0.5) - 0.5) * period * r;   // linear distance to the nearest tick
    float aa = fwidth(d) + 1e-5;
    float line = 1.0 - smoothstep(halfWidthLinear, halfWidthLinear + aa, d);
    float ar = fwidth(r) + 1e-5;
    return line * smoothstep(r0 - ar, r0 + ar, r) * (1.0 - smoothstep(r1 - ar, r1 + ar, r));
}

void main() {
    float r = length(vP);
    float ar = fwidth(r) + 1e-5;
    float edge = 1.0 - smoothstep(1.0 - ar, 1.0 + ar, r);
    // 0 = north, +π/2 = east (atan(0, 0), at the centre vertex, is undefined: 0 there).
    float ang = dot(vP, vP) > 0.0 ? atan(vP.x, vP.y) : 0.0;

    // Translucent lens: faint centre, brighter toward the rim.
    float fill = mix(0.30, 1.0, smoothstep(0.0, 1.0, r * r));
    float rim = 1.0 - smoothstep(0.0, ar * 1.5, abs(r - (1.0 - 1.5 * ar)));
    float ring = (1.0 - smoothstep(0.0, ar * 1.2, abs(r - 0.5))) * 0.35;
    float minor = ticks(ang, r, PI / 6.0, 0.004, 0.90, 0.99) * 0.55;
    float major = ticks(ang, r, PI / 2.0, 0.008, 0.74, 0.99);
    float north = ticks(ang, r, 2.0 * PI, 0.011, 0.64, 0.99);   // period 2π: only the north tick
    // Only after every fwidth() above: derivatives are undefined once lanes have been discarded.
    if (r > 1.0 + ar) discard;

    vec3 col = uColor * (fill * 0.18 + rim * 0.55 + ring * 0.25 + minor * 0.35 + major * 0.75);
    float a = fill * 0.18 + rim * 0.5 + ring * 0.15 + minor * 0.3 + major * 0.7;
    col = mix(col, uNorth * 1.3, north);
    a = max(a, north * 0.95);
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * edge * uAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const RIPPLE_VERT = /* glsl */ `
varying vec2 vP;   // -1..1 across the quad
void main() {
    vP = vec2(position.x, -position.z) * 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RIPPLE_FRAG = /* glsl */ `
uniform vec2 uRings;   // progress of the two rings, 0..1 (≤ 0: inactive)
uniform float uFoot;   // foot glow intensity
uniform float uFlash;  // impact flash
uniform float uAlpha;
uniform vec3 uColor;
varying vec2 vP;

float ring(float r, float t) {
    if (t <= 0.0 || t >= 1.0) return 0.0;
    float rad = 1.0 - (1.0 - t) * (1.0 - t) * (1.0 - t);   // easeOutCubic radius
    float w = 0.018 + 0.05 * t;
    float d = (r - rad) / w;
    return exp(-d * d) * (1.0 - t) * (1.0 - t);
}

void main() {
    float r = length(vP);
    float a = uFoot * (exp(-r * r * 260.0) * 1.4 + exp(-r * r * 40.0) * 0.25);
    a += uFlash * exp(-r * r * 30.0);
    a += ring(r, uRings.x) * 1.6 + ring(r, uRings.y) * 1.0;
    a *= 1.0 - smoothstep(0.92, 1.0, r);
    gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const HEAD_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
}
`;

const HEAD_FRAG = /* glsl */ `
uniform vec3 uRim;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
void main() {
    float f = pow(1.0 - clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.0);
    vec3 c = mix(vec3(1.0, 0.97, 0.92) * 1.9, uRim * 2.6, f);
    gl_FragColor = vec4(c, uAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const SPIKE_VERT = /* glsl */ `
varying float vH;
void main() {
    vH = position.y / ${SPIKE_H.toFixed(4)} + 0.5;   // 0 at the ground, 1 at the head
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SPIKE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying float vH;
void main() {
    float k = mix(0.35, 1.6, vH * vH);
    gl_FragColor = vec4(uColor * k, uAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const HALO_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vP;
void main() {
    vP = position.xy * 2.0;
    vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    c.xy += position.xy * uSize;
    c.z += uSize * 0.5;            // toward the camera, so the surface does not clip it at grazing angles
    gl_Position = projectionMatrix * c;
}
`;

const HALO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vP;
void main() {
    float r2 = dot(vP, vP);
    float a = exp(-r2 * 9.0) * 0.4 + exp(-r2 * 40.0) * 0.45;
    a *= 1.0 - smoothstep(0.8, 1.0, sqrt(r2));
    gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/**
 * Creates the pin module.
 * @param {object} rc RenderContext (SPEC §C.6)
 * @param {{now?:()=>number, reducedMotion?:boolean}} [deps]
 * @returns {object} RenderModule & {drop, setObserver, prime, cardinals, setReducedMotion}
 */
export function createPin(rc, deps = {}) {
    const now = typeof deps.now === 'function' ? deps.now : nowMs;
    let reducedMotion = deps.reducedMotion ?? prefersReducedMotion();
    const invalidate = () => { try { rc?.invalidate?.(); } catch { /* never throw from a redraw request */ } };

    const group = new THREE.Group();
    group.name = 'pin';
    group.matrixAutoUpdate = false;

    // Local tangent frame at the observer: X = east, Y = up, Z = south.
    const anchor = new THREE.Group();
    anchor.matrixAutoUpdate = false;
    group.add(anchor);

    // ---- horizon disc ----
    const discGeo = new THREE.CircleGeometry(DISC_R, 64);
    discGeo.rotateX(-Math.PI / 2);
    const discMat = new THREE.ShaderMaterial({
        name: 'pin.disc',
        uniforms: {
            uAlpha: { value: 1 },
            uColor: { value: new THREE.Color(0.62, 0.8, 1.0) },
            uNorth: { value: NORTH.clone() },
        },
        vertexShader: DISC_VERT,
        fragmentShader: DISC_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: true,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
    });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.name = 'pin.disc';
    disc.position.y = DISC_LIFT;
    disc.renderOrder = 29;
    anchor.add(disc);

    // ---- ripple + foot glow (scaled with the pin) ----
    const rippleGeo = new THREE.PlaneGeometry(1, 1);
    rippleGeo.rotateX(-Math.PI / 2);
    const rippleMat = new THREE.ShaderMaterial({
        name: 'pin.ripple',
        uniforms: {
            uRings: { value: new THREE.Vector2(0, 0) },
            uFoot: { value: 1 },
            uFlash: { value: 0 },
            uAlpha: { value: 1 },
            uColor: { value: ACCENT.clone() },
        },
        vertexShader: RIPPLE_VERT,
        fragmentShader: RIPPLE_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
    });
    const ripple = new THREE.Mesh(rippleGeo, rippleMat);
    ripple.name = 'pin.ripple';
    ripple.position.y = RIPPLE_LIFT;
    ripple.renderOrder = 29.5;
    anchor.add(ripple);

    // ---- pin body: spike, head, halo (scaled and animated together) ----
    const body = new THREE.Group();
    body.name = 'pin.body';
    anchor.add(body);
    const drop = new THREE.Group();   // vertical offset during the drop animation
    body.add(drop);

    const spikeGeo = new THREE.CylinderGeometry(0.0021, 0.0028, SPIKE_H, 10, 1, true);
    const spikeMat = new THREE.ShaderMaterial({
        name: 'pin.spike',
        uniforms: { uColor: { value: ACCENT.clone() }, uAlpha: { value: 1 } },
        vertexShader: SPIKE_VERT,
        fragmentShader: SPIKE_FRAG,
        transparent: true,
        depthWrite: false,
    });
    const spike = new THREE.Mesh(spikeGeo, spikeMat);
    spike.position.y = SPIKE_H / 2;
    spike.renderOrder = 40;
    drop.add(spike);

    const headGeo = new THREE.SphereGeometry(HEAD_R, 24, 16);
    const headMat = new THREE.ShaderMaterial({
        name: 'pin.head',
        uniforms: { uRim: { value: ACCENT.clone() }, uAlpha: { value: 1 } },
        vertexShader: HEAD_VERT,
        fragmentShader: HEAD_FRAG,
        transparent: true,
        depthWrite: true,
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = SPIKE_H;
    head.renderOrder = 40;
    drop.add(head);

    const haloGeo = new THREE.PlaneGeometry(1, 1);
    const haloMat = new THREE.ShaderMaterial({
        name: 'pin.halo',
        uniforms: { uSize: { value: HALO_SIZE }, uColor: { value: ACCENT.clone() }, uAlpha: { value: 1 } },
        vertexShader: HALO_VERT,
        fragmentShader: HALO_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.y = SPIKE_H;
    halo.renderOrder = 41;
    halo.frustumCulled = false;
    drop.add(halo);

    // ---- state ----
    const posL = new Float64Array(3);
    const enu = { east: new Float64Array(3), north: new Float64Array(3), up: new Float64Array(3) };
    const earthM = new THREE.Matrix4();
    const pinW = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const cardinals = { N: new Float64Array(3), E: new Float64Array(3), S: new Float64Array(3), W: new Float64Array(3) };
    let lat = NaN;
    let lon = NaN;
    let layers = { horizon: true };
    let skyBlend = 0;
    let pinScale = 1;
    let primed = false;
    let anim = null; // {t0}
    /** @type {null|((done:boolean)=>void)} */
    let dropResolve = null;

    function writeCardinals() {
        const m = earthM.elements;
        rimPoint(m, posL, enu, 0, 1, cardinals.N);
        rimPoint(m, posL, enu, 1, 0, cardinals.E);
        rimPoint(m, posL, enu, 0, -1, cardinals.S);
        rimPoint(m, posL, enu, -1, 0, cardinals.W);
    }

    /**
     * Places the pin at a geodetic lat/lon (Earth-fixed; the group carries the rotation).
     * @param {number} latDeg
     * @param {number} lonDeg
     */
    function setObserver(latDeg, lonDeg) {
        if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return;
        if (latDeg === lat && lonDeg === lon) return;
        lat = latDeg;
        lon = lonDeg;
        latLonToLocal(lat, lon, posL);
        enuLocal(lat, lon, enu);
        // Columns: X = east, Y = up, Z = east × up = south.
        anchor.matrix.set(
            enu.east[0], enu.up[0], -enu.north[0], posL[0],
            enu.east[1], enu.up[1], -enu.north[1], posL[1],
            enu.east[2], enu.up[2], -enu.north[2], posL[2],
            0, 0, 0, 1,
        );
        anchor.matrixWorldNeedsUpdate = true;
        writeCardinals();
        invalidate();
    }

    function apply(snap) {
        if (!snap) return;
        if (snap.earthMatrix) {
            earthM.fromArray(snap.earthMatrix);
            group.matrix.copy(earthM);
            group.matrixWorldNeedsUpdate = true;
        }
        const o = snap.observer;
        if (o) setObserver(o.latDeg, o.lonDeg);
        writeCardinals();
    }

    function settleDrop(done) {
        const r = dropResolve;
        dropResolve = null;
        anim = null;
        if (r) r(done);
    }

    function stepAnimation(t) {
        if (!anim) return;
        const e = t - anim.t0;
        // Body: free fall, then a small settle bounce.
        let y = 0;
        if (e < FALL_MS) {
            y = (1 - easeInQuad(e / FALL_MS)) * 0.32;
        } else if (e < FALL_MS + SETTLE_MS) {
            const k = (e - FALL_MS) / SETTLE_MS;
            y = Math.sin(k * Math.PI) * 0.018 * (1 - k);
        }
        drop.position.y = y * pinScale;
        // Ripple rings start at impact.
        const r1 = (e - FALL_MS) / RIPPLE_MS;
        const r2 = (e - FALL_MS - RIPPLE_STAGGER) / RIPPLE_MS;
        rippleMat.uniforms.uRings.value.set(r1, r2);
        const fl = (e - FALL_MS) / 260;
        rippleMat.uniforms.uFlash.value = fl > 0 && fl < 1 ? (1 - fl) * (1 - fl) * 1.6 : 0;
        rippleMat.uniforms.uFoot.value = e < FALL_MS ? easeOutCubic(e / FALL_MS) * 0.6 : 1;
        if (r2 >= 1) {
            drop.position.y = 0;
            rippleMat.uniforms.uRings.value.set(0, 0);
            rippleMat.uniforms.uFlash.value = 0;
            rippleMat.uniforms.uFoot.value = 1;
            settleDrop(true);
        }
    }

    function updateVisibility() {
        const orbitK = 1 - smoothstep(0.0, 0.4, skyBlend);
        group.visible = orbitK > 0.001;
        body.visible = !primed;
        ripple.visible = !primed || anim !== null;
        disc.visible = layers.horizon !== false;
        const discK = orbitK;
        discMat.uniforms.uAlpha.value = discK;
        rippleMat.uniforms.uAlpha.value = orbitK;
        spikeMat.uniforms.uAlpha.value = orbitK;
        headMat.uniforms.uAlpha.value = orbitK;
        haloMat.uniforms.uAlpha.value = orbitK;
    }

    function update(fi) {
        if (fi && Number.isFinite(fi.skyBlend)) skyBlend = fi.skyBlend;
        const cam = (fi && fi.camera) || rc?.camera;
        if (cam && Number.isFinite(lat)) {
            // Keep a near-constant screen size.
            pinW.set(posL[0], posL[1], posL[2]).applyMatrix4(earthM);
            const d = tmp.copy(cam.position).sub(pinW).length();
            const s = Math.min(3, Math.max(0.06, d / REF_DIST));
            if (Math.abs(s - pinScale) > 1e-4) {
                pinScale = s;
                body.scale.setScalar(s);
                ripple.scale.setScalar(s * RIPPLE_R * 2);
                haloMat.uniforms.uSize.value = HALO_SIZE * s;
            }
        }
        if (anim) {
            stepAnimation(now());
            invalidate();
        }
        updateVisibility();
    }

    /**
     * Drops the pin from above with a ripple on impact.
     * @returns {Promise<boolean>} resolves when the ripple has finished (false if superseded).
     */
    function dropPin() {
        if (dropResolve) settleDrop(false);
        primed = false;
        if (reducedMotion) {
            drop.position.y = 0;
            updateVisibility();
            invalidate();
            return Promise.resolve(true);
        }
        anim = { t0: now() };
        stepAnimation(anim.t0);
        updateVisibility();
        invalidate();
        return new Promise((resolve) => { dropResolve = resolve; });
    }

    ripple.scale.setScalar(RIPPLE_R * 2);
    updateVisibility();

    return {
        object3d: group,
        apply,
        update,
        setObserver,
        drop: dropPin,
        /** Hides the pin until the next drop() (intro). */
        prime() {
            if (dropResolve) settleDrop(false);
            primed = true;
            updateVisibility();
            invalidate();
        },
        /** Live world points at the horizon disc's N/E/S/W rim (Float64Array(3) each). */
        cardinals,
        setLayers(l) {
            if (!l) return;
            layers = { horizon: l.horizon !== false };
            updateVisibility();
            invalidate();
        },
        setViewMode(mode, sb) {
            skyBlend = Number.isFinite(sb) ? sb : mode === 'sky' ? 1 : 0;
            updateVisibility();
            invalidate();
        },
        setSelection() {},
        setQuality() {},
        setReducedMotion(on) {
            reducedMotion = !!on;
        },
        dispose() {
            if (dropResolve) settleDrop(false);
            group.removeFromParent();
            for (const g of [discGeo, rippleGeo, spikeGeo, headGeo, haloGeo]) g.dispose();
            for (const m of [discMat, rippleMat, spikeMat, headMat, haloMat]) m.dispose();
        },
    };
}

function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/**
 * World point on the horizon disc rim: earthMatrix · (posL·(1+lift) + (east·ex + north·nx)·R).
 * @param {ArrayLike<number>} m column-major earth matrix elements
 */
function rimPoint(m, posL, enu, ex, nx, out) {
    const lx = posL[0] * (1 + DISC_LIFT) + (enu.east[0] * ex + enu.north[0] * nx) * DISC_R;
    const ly = posL[1] * (1 + DISC_LIFT) + (enu.east[1] * ex + enu.north[1] * nx) * DISC_R;
    const lz = posL[2] * (1 + DISC_LIFT) + (enu.east[2] * ex + enu.north[2] * nx) * DISC_R;
    out[0] = m[0] * lx + m[4] * ly + m[8] * lz;
    out[1] = m[1] * lx + m[5] * ly + m[9] * lz;
    out[2] = m[2] * lx + m[6] * ly + m[10] * lz;
}
