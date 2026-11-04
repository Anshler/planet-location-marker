/**
 * Satellites (astro/satellites.js, the extras registry's 'sat' kind): a render module.
 *
 * - Globe: a dot at each satellite's true place (Earth radii, depth-tested against the globe;
 *   grey while it is in the Earth's shadow), a short beam from the pin to each one above the
 *   observer's horizon (the signature beam shaders, no pulses), and the ground track of the
 *   featured satellite (the selected one, else the ISS) one orbit either side of now: one
 *   preallocated line in the Earth's frame, brighter ahead than behind, re-centred every few
 *   minutes of sim time.
 * - Sky view: each satellite as a point drawn with the star field's own material (render/sky.js
 *   `starMaterial`), at its magnitude from range and phase angle — nothing at all in the Earth's
 *   shadow — and a ring around the selected one (which stays, so a pass can be followed into the
 *   shadow).
 *
 * Motion: the frame loop advances the satellites' ExtraStates to every frame's instant
 * (registry.advance), and update(fi) re-uploads the few points it draws, so the ISS glides at 1×
 * instead of stepping with the 0.5 s snapshots. `moving(skyBlend)` tells the loop to keep drawing
 * while one is up in sky view (attach's liveMotion).
 *
 * Fixed buffers (R5); colours and ids are re-read only when the registry changes.
 *
 * @module render/satellites
 */
import * as THREE from 'three';
import { BEAM_VERT, BEAM_FRAG } from './shaders/beam.glsl.js';
import { INFINITY_VERT_CHUNK } from './shaders/sky.glsl.js';
import { bvToRgb, liftByRefraction } from '../astro/photometry.js';
import { groundTrack } from '../astro/satellites.js';

const CAP = 8;
const TRACK_N = 241;
const TRACK_R = 1.008;                 // just over the cloud shell (render/earth.js CLOUD_RADIUS 1.006)
const TRACK_RECENTRE_MIN = 6;          // re-centre the track when sim time drifts this far (minutes)
const DOT_PX = 7;
const RETICLE_PX = 26;
const SKY_RETICLE_PX = 30;
const GLOW_PX = 5;
const ORIGIN_LIFT = 1.002;
/** A satellite's colour in the sky: sunlit aluminium and solar panels read about white. */
const SAT_BV = 0.45;

const DOT_VERT = /* glsl */ `
uniform float uPx;
attribute vec3 aColor;
attribute float aSize;
attribute float aStyle;
varying vec3 vColor;
varying float vStyle;
void main() {
    vColor = aColor;
    vStyle = aStyle;
    gl_PointSize = aSize * uPx;
    gl_Position = aSize > 0.0 ? projectionMatrix * modelViewMatrix * vec4(position, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const SKY_MARK_VERT = /* glsl */ `
uniform float uPx;
attribute vec3 aColor;
attribute float aSize;
attribute float aStyle;
varying vec3 vColor;
varying float vStyle;
${INFINITY_VERT_CHUNK}
void main() {
    vColor = aColor;
    vStyle = aStyle;
    gl_PointSize = aSize * uPx;
    gl_Position = aSize > 0.0 ? infinityClip(normalize(position)) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const MARK_FRAG = /* glsl */ `
uniform float uAlpha;
varying vec3 vColor;
varying float vStyle;
void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    float a;
    if (vStyle < 0.5) {
        // A dot with a soft halo (the satellite on the globe).
        a = (1.0 - smoothstep(0.32, 0.46, r)) + 0.35 * (1.0 - smoothstep(0.46, 1.0, r));
    } else {
        // The selection ring.
        a = smoothstep(0.74, 0.80, r) * (1.0 - smoothstep(0.88, 0.95, r));
    }
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * (a * uAlpha), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const TRACK_VERT = /* glsl */ `
attribute float aMin;
varying float vMin;
void main() {
    vMin = aMin;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TRACK_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uNow;
uniform float uSpan;
uniform float uAlpha;
varying float vMin;
void main() {
    float d = vMin - uNow;
    // Ahead of the satellite bright, behind it faint; both ends fade one orbit out.
    float a = (d >= 0.0 ? 0.85 : 0.32) * (1.0 - smoothstep(0.7 * uSpan, uSpan, abs(d)));
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor * (a * uAlpha), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

function buildStrip(segments) {
    const g = new THREE.InstancedBufferGeometry();
    const rows = segments + 1;
    const pos = new Float32Array(rows * 2 * 3);
    for (let i = 0; i < rows; i++) {
        const s = i / segments;
        pos[i * 6] = s; pos[i * 6 + 1] = -1; pos[i * 6 + 3] = s; pos[i * 6 + 4] = 1;
    }
    const idx = new Uint16Array(segments * 6);
    for (let i = 0; i < segments; i++) {
        const a = i * 2;
        idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.instanceCount = 0;
    return g;
}

function pointsGeometry(n, extra) {
    const g = new THREE.BufferGeometry();
    const attrs = { position: new THREE.BufferAttribute(new Float32Array(n * 3), 3) };
    for (const [name, size] of extra) attrs[name] = new THREE.BufferAttribute(new Float32Array(n * size), size);
    for (const [name, a] of Object.entries(attrs)) { a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, a); }
    g.setDrawRange(0, 0);
    return { g, attrs, list: Object.values(attrs) };
}

/**
 * Creates the satellites module.
 * @param {object} rc RenderContext
 * @param {{extras:any, sky?:any}} deps the registry; the sky module (its star material)
 * @returns {object} RenderModule & {moving(skyBlend:number):boolean, pickCandidates(sky:boolean, camera:any):Array}
 */
export function createSatellites(rc, { extras, sky = null } = {}) {
    const group = new THREE.Group();
    group.name = 'satellites';

    // --- dots on the globe (+ the selection ring) ----------------------------------------------
    const dots = pointsGeometry(CAP + 1, [['aColor', 3], ['aSize', 1], ['aStyle', 1]]);
    const dotUniforms = { uPx: { value: 1 }, uAlpha: { value: 1 } };
    const dotMat = new THREE.ShaderMaterial({
        name: 'satellites.dots', uniforms: dotUniforms, vertexShader: DOT_VERT, fragmentShader: MARK_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    const dotPoints = new THREE.Points(dots.g, dotMat);
    dotPoints.name = 'satellites.dots';
    dotPoints.renderOrder = 41;

    // --- the sky view: star-material points and the selection ring at infinity ------------------
    const skyPts = pointsGeometry(CAP, [['aMag', 1], ['aColor', 3]]);
    const starMat = sky && sky.starMaterial ? sky.starMaterial : null;
    const skyPoints = starMat ? new THREE.Points(skyPts.g, starMat) : null;
    if (skyPoints) { skyPoints.name = 'satellites.sky'; skyPoints.renderOrder = -68; }
    const satRgb = bvToRgb(SAT_BV, [1, 1, 1]);
    const ring = pointsGeometry(1, [['aColor', 3], ['aSize', 1], ['aStyle', 1]]);
    const upS = new THREE.Vector3(0, 1, 0);
    const ringUniforms = { uPx: { value: 1 }, uAlpha: { value: 0.85 }, uRefrUp: { value: upS }, uRefrK: { value: 1 } };
    const ringMat = new THREE.ShaderMaterial({
        name: 'satellites.ring', uniforms: ringUniforms, vertexShader: SKY_MARK_VERT, fragmentShader: MARK_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    const ringPoints = new THREE.Points(ring.g, ringMat);
    ringPoints.name = 'satellites.ring';
    ringPoints.renderOrder = 45;

    // --- beams from the pin -------------------------------------------------------------------
    const strip = buildStrip(12);
    const bAttr = {
        iOrigin: new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3),
        iDir: new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3),
        iColor: new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3),
        iLen: new THREE.InstancedBufferAttribute(new Float32Array(CAP), 1),
        iState: new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4),
    };
    for (const [name, a] of Object.entries(bAttr)) { a.setUsage(THREE.DynamicDrawUsage); strip.setAttribute(name, a); }
    const bList = Object.values(bAttr);
    const beamUniforms = {
        uNear: { value: 0.05 }, uViewport: { value: new THREE.Vector2(1, 1) }, uGlowPx: { value: GLOW_PX },
        uDpr: { value: 1 }, uPulses: { value: 0 }, uPhase: { value: 0 }, uFade: { value: 1 }, uSelActive: { value: 0 },
        uRootClear: { value: 0 }, uTint: { value: new THREE.Color('#ffffff') },
    };
    const beamMat = new THREE.ShaderMaterial({
        name: 'satellites.beams', uniforms: beamUniforms, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const beams = new THREE.Mesh(strip, beamMat);
    beams.name = 'satellites.beams';
    beams.renderOrder = 31;

    // --- the ground track, in the Earth's frame ------------------------------------------------
    const trackPos = new Float32Array(TRACK_N * 3);
    const trackMin = new Float32Array(TRACK_N);
    const trackGeom = new THREE.BufferGeometry();
    const trackPosAttr = new THREE.BufferAttribute(trackPos, 3);
    const trackMinAttr = new THREE.BufferAttribute(trackMin, 1);
    trackGeom.setAttribute('position', trackPosAttr);
    trackGeom.setAttribute('aMin', trackMinAttr);
    trackGeom.setDrawRange(0, 0);
    const trackUniforms = { uColor: { value: new THREE.Color('#ffffff') }, uNow: { value: 0 }, uSpan: { value: 90 }, uAlpha: { value: 1 } };
    const trackMat = new THREE.ShaderMaterial({
        name: 'satellites.track', uniforms: trackUniforms, vertexShader: TRACK_VERT, fragmentShader: TRACK_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    const track = new THREE.Line(trackGeom, trackMat);
    track.name = 'satellites.track';
    track.renderOrder = 25;
    const earthFrame = new THREE.Group();
    earthFrame.name = 'satellites.earthFrame';
    earthFrame.matrixAutoUpdate = false;
    earthFrame.add(track);

    for (const o of [dotPoints, skyPoints, ringPoints, beams, track]) {
        if (!o) continue;
        o.frustumCulled = false;
        o.matrixAutoUpdate = false;
    }
    group.add(earthFrame, dotPoints, ringPoints, beams);
    if (skyPoints) group.add(skyPoints);

    // --- registry slots ---------------------------------------------------------------------------
    /** @type {{id:string, rgb:number[], color:THREE.Color}[]} */
    let sats = [];
    let builtVersion = -1;
    /** Indices of the 'sat' states in snap.extras, for the snapshot's extrasVersion. */
    let idx = [];
    let idxVersion = -1;
    const readSlots = () => {
        builtVersion = extras ? extras.version : 0;
        sats = (extras?.ids?.('sat') ?? []).slice(0, CAP).map((id) => {
            const c = new THREE.Color(extras.meta(id)?.color ?? '#ffffff');
            return { id, color: c, rgb: [c.r, c.g, c.b] };
        });
        idxVersion = -1;
        trackId = '';
    };
    const offChange = extras?.onChange?.(readSlots) ?? null;

    let layers = { satellites: true, beams: true };
    let selection = null;
    let skyBlend = 0;
    let systemBlend = 0;
    let lastSnap = null;
    let anyUp = false;
    // The track: whose, centred when.
    let trackId = '';
    let trackT0 = NaN;
    let trackSpan = 90;
    const _size = new THREE.Vector2();
    const _lift = new Float64Array(3);
    readSlots();

    function statesOf(snap) {
        if (!snap?.extras || !extras) return null;
        if (builtVersion !== extras.version) readSlots();
        if (idxVersion !== snap.extrasVersion) {
            idx = sats.map((s) => snap.extras.findIndex((st) => st.id === s.id));
            idxVersion = snap.extrasVersion;
        }
        return snap.extras;
    }

    /** The satellite whose ground track is drawn: the selected one, else the first (the ISS). */
    function featured() {
        if (selection && sats.some((s) => s.id === selection)) return selection;
        return sats[0]?.id ?? '';
    }

    function syncTrack(snap) {
        const id = featured();
        const p = extras?.provider?.('sat');
        const sat = id && p?.sat ? p.sat(id) : null;
        const xs = statesOf(snap);
        const k = sats.findIndex((s) => s.id === id);
        const st = xs && k >= 0 && idx[k] >= 0 ? xs[idx[k]] : null;
        if (!sat || !st || !st.present) { trackGeom.setDrawRange(0, 0); trackId = ''; return; }
        const t = snap.tMs;
        if (id === trackId && Math.abs(t - trackT0) < TRACK_RECENTRE_MIN * 60000) return;
        trackId = id;
        trackT0 = t;
        trackSpan = sat.periodMin;
        groundTrack(sat, t, sat.periodMin * 60000, TRACK_N, TRACK_R, trackPos, trackMin);
        trackPosAttr.needsUpdate = true;
        trackMinAttr.needsUpdate = true;
        trackGeom.setDrawRange(0, TRACK_N);
        trackUniforms.uColor.value.copy(sats[k].color);
        trackUniforms.uSpan.value = trackSpan;
    }

    function apply(snap) {
        if (!snap) return;
        lastSnap = snap;
        if (snap.earthMatrix) {
            earthFrame.matrix.fromArray(snap.earthMatrix);
            earthFrame.matrixWorldNeedsUpdate = true;
        }
        if (layers.satellites) syncTrack(snap);
    }

    /** Fills every buffer from the (advanced) states. No allocation. */
    function draw(fi) {
        const snap = fi?.snap ?? lastSnap;
        const xs = statesOf(snap);
        const on = layers.satellites === true && !!xs;
        const globe = on && skyBlend < 0.5 && systemBlend < 0.999;
        const inSky = on && skyBlend >= 0.5;
        const o = snap?.observer;
        const up = o?.upS;
        if (up) upS.set(up[0], up[1], up[2]);
        const dp = dots.attrs.position.array, dc = dots.attrs.aColor.array, ds = dots.attrs.aSize.array, dst = dots.attrs.aStyle.array;
        const sp = skyPts.attrs.position.array, sm = skyPts.attrs.aMag.array, sc = skyPts.attrs.aColor.array;
        const bo = bAttr.iOrigin.array, bd = bAttr.iDir.array, bc = bAttr.iColor.array, bl = bAttr.iLen.array, bs = bAttr.iState.array;
        let nd = 0, ns = 0, nb = 0, selSt = null, selK = -1;
        anyUp = false;
        // The star shader's limiting magnitude for this sky (STAR_VERT: mix(−1, limit, √exposure)).
        const e = Math.max(0, Math.min(1, Number.isFinite(fi?.exposure?.stars) ? fi.exposure.stars : 1));
        const visLim = -1 + 7.5 * Math.sqrt(e) + 0.4;
        for (let k = 0; on && k < sats.length; k++) {
            const i = idx[k];
            const st = i >= 0 ? xs[i] : null;
            if (!st || !st.present || !st.data) continue;
            const s = sats[k];
            const P = st.data.posS;
            const lit = st.data.look.lit;
            if (s.id === selection) { selSt = st; selK = k; }
            // Up and to be seen (bright enough for this sky, as the star shader draws it), or ringed.
            if (st.altDeg > -1 && (s.id === selection || (Number.isFinite(st.mag) && st.mag < visLim))) anyUp = true;
            if (globe) {
                dp[nd * 3] = P[0]; dp[nd * 3 + 1] = P[1]; dp[nd * 3 + 2] = P[2];
                const g = 0.3 + 0.7 * lit;
                dc[nd * 3] = s.rgb[0] * g + 0.25 * (1 - lit); dc[nd * 3 + 1] = s.rgb[1] * g + 0.25 * (1 - lit); dc[nd * 3 + 2] = s.rgb[2] * g + 0.3 * (1 - lit);
                ds[nd] = DOT_PX * (k === 0 ? 1.25 : 1);
                dst[nd] = 0;
                nd++;
                if (st.above && layers.beams !== false && o?.posS) {
                    const ox = o.posS[0] * ORIGIN_LIFT, oy = o.posS[1] * ORIGIN_LIFT, oz = o.posS[2] * ORIGIN_LIFT;
                    const vx = P[0] - ox, vy = P[1] - oy, vz = P[2] - oz;
                    const L = Math.hypot(vx, vy, vz) || 1;
                    bo[nb * 3] = ox; bo[nb * 3 + 1] = oy; bo[nb * 3 + 2] = oz;
                    bd[nb * 3] = vx / L; bd[nb * 3 + 1] = vy / L; bd[nb * 3 + 2] = vz / L;
                    bl[nb] = L;
                    bc[nb * 3] = s.rgb[0]; bc[nb * 3 + 1] = s.rgb[1]; bc[nb * 3 + 2] = s.rgb[2];
                    bs[nb * 4] = s.id === selection ? 1 : 0; bs[nb * 4 + 1] = 0; bs[nb * 4 + 2] = 1; bs[nb * 4 + 3] = 1;
                    nb++;
                }
            }
            if (inSky && ns < CAP) {
                const d = st.dirS;
                sp[ns * 3] = d[0]; sp[ns * 3 + 1] = d[1]; sp[ns * 3 + 2] = d[2];
                sm[ns] = Number.isFinite(st.mag) ? st.mag : 99;
                sc[ns * 3] = satRgb[0]; sc[ns * 3 + 1] = satRgb[1]; sc[ns * 3 + 2] = satRgb[2];
                ns++;
            }
        }
        // The selection: a ring around the dot (globe) or at its place in the sky.
        let nr = 0;
        if (selSt && globe) {
            const P = selSt.data.posS, c = sats[selK].rgb;
            dp[nd * 3] = P[0]; dp[nd * 3 + 1] = P[1]; dp[nd * 3 + 2] = P[2];
            dc[nd * 3] = 0.4 + 0.6 * c[0]; dc[nd * 3 + 1] = 0.4 + 0.6 * c[1]; dc[nd * 3 + 2] = 0.4 + 0.6 * c[2];
            ds[nd] = RETICLE_PX;
            dst[nd] = 1;
            nd++;
        } else if (selSt && inSky) {
            const rp = ring.attrs.position.array, rc3 = ring.attrs.aColor.array, c = sats[selK].rgb;
            rp[0] = selSt.dirS[0]; rp[1] = selSt.dirS[1]; rp[2] = selSt.dirS[2];
            rc3[0] = 0.4 + 0.6 * c[0]; rc3[1] = 0.4 + 0.6 * c[1]; rc3[2] = 0.4 + 0.6 * c[2];
            ring.attrs.aSize.array[0] = SKY_RETICLE_PX;
            ring.attrs.aStyle.array[0] = 1;
            nr = 1;
        }
        dots.g.setDrawRange(0, nd);
        for (let j = 0; j < dots.list.length; j++) dots.list[j].needsUpdate = true;
        skyPts.g.setDrawRange(0, ns);
        for (let j = 0; j < skyPts.list.length; j++) skyPts.list[j].needsUpdate = true;
        ring.g.setDrawRange(0, nr);
        for (let j = 0; j < ring.list.length; j++) ring.list[j].needsUpdate = true;
        strip.instanceCount = nb;
        for (let j = 0; j < bList.length; j++) bList[j].needsUpdate = true;
        beamUniforms.uSelActive.value = selSt && nb > 0 ? 1 : 0;
        dotPoints.visible = nd > 0;
        if (skyPoints) skyPoints.visible = ns > 0;
        ringPoints.visible = nr > 0;
        beams.visible = nb > 0;
        track.visible = globe && trackGeom.drawRange.count > 0;
        if (track.visible && Number.isFinite(fi?.tMs)) trackUniforms.uNow.value = (fi.tMs - trackT0) / 60000;
    }

    return {
        object3d: group,
        apply,
        update(fi) {
            if (!fi) return;
            if (Number.isFinite(fi.skyBlend)) skyBlend = fi.skyBlend;
            systemBlend = Number.isFinite(fi.systemBlend) ? fi.systemBlend : 0;
            const dpr = Math.max(1, rc?.dpr || 1);
            dotUniforms.uPx.value = dpr;
            ringUniforms.uPx.value = dpr;
            ringUniforms.uRefrK.value = Math.max(0, Math.min(1, skyBlend));
            const fade = (1 - Math.min(1, Math.max(0, (skyBlend - 0.2) / 0.3))) * (1 - systemBlend);
            beamUniforms.uFade.value = fade;
            trackUniforms.uAlpha.value = fade;
            dotUniforms.uAlpha.value = fade;
            draw(fi);
            if (beams.visible) {
                const cam = fi.camera || rc?.camera;
                if (cam) beamUniforms.uNear.value = cam.near;
                const r = rc?.renderer;
                if (r) {
                    r.getDrawingBufferSize(_size);
                    beamUniforms.uViewport.value.copy(_size);
                    const d = r.getPixelRatio();
                    beamUniforms.uDpr.value = d;
                    beamUniforms.uGlowPx.value = GLOW_PX * d;
                }
            }
        },
        setLayers(l) {
            if (!l) return;
            const was = layers.satellites;
            layers = { satellites: l.satellites === true, beams: l.beams !== false };
            if (layers.satellites && !was && lastSnap) { trackId = ''; syncTrack(lastSnap); }
            if (lastSnap) draw(null);
        },
        setSelection(id) {
            selection = id || null;
            if (lastSnap) { syncTrack(lastSnap); draw(null); }
        },
        setViewMode(_m, blend) { if (Number.isFinite(blend)) skyBlend = blend; },
        setQuality() {},
        /** A satellite is up (layer on, sky view): it moves visibly at 1×, so keep drawing. */
        moving(blend = skyBlend) {
            return layers.satellites === true && blend >= 0.5 && anyUp;
        },
        /**
         * Pick candidates: in sky view each present satellite above the horizon at its drawn
         * (refraction-lifted) direction ({id, dirS}); on the globe each dot the camera can see
         * ({id, posS}, those behind the Earth left out).
         * @param {boolean} skyView
         * @param {{position:{x:number,y:number,z:number}}} [camera]
         */
        pickCandidates(skyView, camera) {
            const out = [];
            const snap = lastSnap;
            const xs = statesOf(snap);
            if (!xs || !layers.satellites) return out;
            for (let k = 0; k < sats.length; k++) {
                const st = idx[k] >= 0 ? xs[idx[k]] : null;
                if (!st || !st.present || !st.data) continue;
                if (skyView) {
                    if (!st.above) continue;
                    const up = snap.observer?.upS;
                    out.push({ id: st.id, dirS: up ? liftByRefraction(st.dirS, up, 1, new Float64Array(3)) : st.dirS });
                } else {
                    const P = st.data.posS;
                    if (camera && segmentHitsEarth(camera.position, P)) continue;
                    out.push({ id: st.id, posS: P });
                }
            }
            return out;
        },
        dispose() {
            offChange?.();
            for (const g of [dots.g, skyPts.g, ring.g, strip, trackGeom]) g.dispose();
            for (const m of [dotMat, ringMat, beamMat, trackMat]) m.dispose();
        },
    };
}

/** True when the segment from the camera to P passes through the unit sphere (the Earth hides P). */
function segmentHitsEarth(c, P) {
    const dx = P[0] - c.x, dy = P[1] - c.y, dz = P[2] - c.z;
    const L2 = dx * dx + dy * dy + dz * dz;
    if (!(L2 > 0)) return false;
    const t = Math.max(0, Math.min(1, -(c.x * dx + c.y * dy + c.z * dz) / L2));
    const x = c.x + dx * t, y = c.y + dy * t, z = c.z + dz * t;
    return x * x + y * y + z * z < 0.998;
}
