/**
 * The celestial sphere (G5, SPEC C.7 / E.5): 5,000 real stars coloured by B−V, constellation
 * figures, the Milky Way, the equatorial grid, the ecliptic and the sky-view alt-az grid.
 *
 * Everything here is static in the J2000 scene frame and drawn "at infinity" (SPEC E.1), so the
 * Earth and Moon occlude it through the depth test. Only the alt-az grid moves: it is re-oriented
 * every frame from the observer's ENU basis.
 */
import * as THREE from 'three';
import { AE } from '../astro/ae.js';
import { STAR_VERT, STAR_FRAG, MW_VERT, MW_FRAG, LINE_VERT, LINE_FRAG } from './shaders/sky.glsl.js';

const DEG = Math.PI / 180;
const OBLIQUITY_DEG = 23.4392911;
/** Milky Way brightness: kept subtle from orbit, fuller from a dark site in sky view. */
const MW_GAIN_ORBIT = 0.18;
const MW_GAIN_SKY = 0.27;

// EQJ → galactic rotation (IAU 1958), rows of gal = M·eqj; from astronomy-engine's Rotation_EQJ_GAL.
const EQJ_TO_GAL = [
    -0.0548624779711344, -0.8734572784246782, -0.4838000529948520,
    +0.4941095946388765, -0.4447938112296831, +0.7470034631630423,
    -0.8676668813529025, -0.1980677870294097, +0.4559861124470794,
];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * Sky-view exposure (SPEC E.5): mix(1, 0.35, smoothstep(−6°, 10°, sunAlt)), crossfaded by the view
 * blend; totality adapts back toward night. G5 applies it inside its own shaders (display-referred)
 * instead of through rc.setExposure, because the bloom pass runs before tone-mapping exposure and a
 * 0.35 exposure would leave the whole daytime sky above the bloom threshold.
 * @param {number} sunAltDeg
 * @param {number} skyBlend 0 (orbit) … 1 (sky view)
 * @param {number} [obscuration] solar-eclipse obscuration at the observer, 0…1
 * @returns {number}
 */
export function skyViewExposure(sunAltDeg, skyBlend, obscuration = 0) {
    const a = Number.isFinite(sunAltDeg) ? sunAltDeg : -90;
    let day = 1 + (0.35 - 1) * smooth(-6, 10, a);
    day += (1 - day) * smooth(0.9, 1.0, Number.isFinite(obscuration) ? obscuration : 0);
    return 1 + (day - 1) * clamp01(Number.isFinite(skyBlend) ? skyBlend : 0);
}

/** skyBlend at which the sky-view ground has fully replaced the globe (see groundCover). */
export const GROUND_COVER_AT = 0.5;

/**
 * Globe ↔ sky transitions: how much of the view below the horizon the sky-view ground covers
 * (0 … 1). The globe's clouds and atmosphere shell fade out with it, and the ground hides the
 * globe surface once it is opaque. Up in the descent the globe's rim sits several degrees below
 * the sky-view horizon, so a globe still half-visible there showed a second, polygon-edged horizon
 * with the shell's limb glow between the two (clipped to white on the low tier). The camera rig
 * therefore keeps the rim out of view until skyBlend reaches GROUND_COVER_AT (rig.js stepToSky and
 * stepToOrbit). 0 in orbit view and 1 in sky view, so neither settled view changes.
 * @param {number} skyBlend 0 (orbit) … 1 (sky view)
 * @returns {number}
 */
export function groundCover(skyBlend) {
    return clamp01((Number.isFinite(skyBlend) ? skyBlend : 0) / GROUND_COVER_AT);
}

/** Mirrors frames.raDecToScene (SPEC D.2): (cosδ·cosα, sinδ, −cosδ·sinα). */
function raDecToScene(raDeg, decDeg, out, o = 0) {
    const a = raDeg * DEG, d = decDeg * DEG;
    out[o] = Math.cos(d) * Math.cos(a);
    out[o + 1] = Math.sin(d);
    out[o + 2] = -Math.cos(d) * Math.sin(a);
    return out;
}

/** Local alt/az (x = east, y = up, z = south) unit vector. */
function altAzLocal(altDeg, azDeg, out, o = 0) {
    const h = altDeg * DEG, A = azDeg * DEG;
    out[o] = Math.sin(A) * Math.cos(h);
    out[o + 1] = Math.sin(h);
    out[o + 2] = -Math.cos(A) * Math.cos(h);
    return out;
}

// ---------------------------------------------------------------------------------------------
// Line layers (shared with trails.js)
// ---------------------------------------------------------------------------------------------

const QUAD_POS = new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]);
const QUAD_IDX = [0, 2, 1, 1, 2, 3];

function makeLineGeometry(capacity) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(QUAD_POS, 3));
    g.setIndex(QUAD_IDX);
    const ab = new Float32Array(Math.max(1, capacity) * 6);
    const st = new Float32Array(Math.max(1, capacity) * 4);
    const ib = new THREE.InstancedInterleavedBuffer(ab, 6, 1);
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 3, 0));
    g.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    const sb = new THREE.InstancedBufferAttribute(st, 4);
    g.setAttribute('iStyle', sb);
    g.instanceCount = 0;
    return { g, ab, st, ib, sb, capacity: Math.max(1, capacity) };
}

/**
 * An anti-aliased line layer at infinity: one instance per segment, drawn as a screen-space quad.
 * @param {{capacity?:number, color:number[], alpha:number, halfWidthPx?:number, gapPx?:number,
 *   renderOrder?:number, defines?:object, name?:string, blending?:number}} opts
 * @returns {{mesh:THREE.Mesh, uniforms:object, ensure(n:number):void, ab:Float32Array, st:Float32Array,
 *   setCount(n:number):void, commit():void, setViewport(w:number,h:number,dpr:number):void, dispose():void}}
 */
export function createLineLayer(opts) {
    const {
        capacity = 64, color, alpha, halfWidthPx = 0.6, gapPx = 0, renderOrder = -80,
        defines = {}, name = 'lines', blending = THREE.NormalBlending,
    } = opts;
    let buf = makeLineGeometry(capacity);
    const uniforms = {
        uViewport: { value: new THREE.Vector2(1, 1) },
        uHalfWidth: { value: halfWidthPx },
        uGap: { value: gapPx },
        uColor: { value: new THREE.Color().setRGB(color[0], color[1], color[2]) },
        uHighlightColor: { value: new THREE.Color(0.75, 0.85, 1.0) },
        uAlpha: { value: alpha },
        uNow: { value: 0 },
        uSpan: { value: 1 },
        uDpr: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
        name, uniforms, defines,
        vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending,
        side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(buf.g, material);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;
    const baseHalfWidth = halfWidthPx, baseGap = gapPx;

    const layer = {
        mesh, uniforms,
        get ab() { return buf.ab; },
        get st() { return buf.st; },
        get capacity() { return buf.capacity; },
        /** Grows the buffers (one-off, never per frame) so `n` segments fit. */
        ensure(n) {
            if (n <= buf.capacity) return;
            const old = buf;
            buf = makeLineGeometry(Math.ceil(n * 1.25));
            mesh.geometry = buf.g;
            old.g.dispose();
        },
        setCount(n) { buf.g.instanceCount = Math.min(n, buf.capacity); },
        commit() { buf.ib.needsUpdate = true; buf.sb.needsUpdate = true; },
        commitStyle() { buf.sb.needsUpdate = true; },
        setViewport(w, h, dpr) {
            uniforms.uViewport.value.set(w, h);
            uniforms.uHalfWidth.value = baseHalfWidth * dpr;
            uniforms.uGap.value = baseGap * dpr;
            uniforms.uDpr.value = dpr;
        },
        dispose() { buf.g.dispose(); material.dispose(); },
    };
    return layer;
}

/** Writes one segment (A→B) with its style into a line layer's arrays at index i. */
function putSeg(layer, i, ax, ay, az, bx, by, bz, alpha = 1, flag = 0, pa = 0, pb = 0) {
    const ab = layer.ab, st = layer.st, o = i * 6, s = i * 4;
    ab[o] = ax; ab[o + 1] = ay; ab[o + 2] = az; ab[o + 3] = bx; ab[o + 4] = by; ab[o + 5] = bz;
    st[s] = alpha; st[s + 1] = flag; st[s + 2] = pa; st[s + 3] = pb;
}

// ---------------------------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------------------------

const LAYER_DEFAULTS = {
    stars: true, constellations: true, milkyWay: true, eqGrid: false, ecliptic: false, altAzGrid: true,
};

/**
 * Creates the celestial sphere.
 * @param {object} rc RenderContext (SPEC C.6)
 * @param {{catalog?:object|null, textures?:object|null, reducedMotion?:boolean}} [deps]
 * @returns {object} RenderModule & {setExposure({stars, milkyWay}), setCatalog(catalog), setReducedMotion(on)}
 */
export function createSky(rc, deps = {}) {
    const { textures = null } = deps;
    const group = new THREE.Group();
    group.name = 'sky';

    const layers = { ...LAYER_DEFAULTS };
    const exposure = { stars: 1, milkyWay: 1 };
    let cfg = rc && rc.tier && typeof rc.tier === 'object' ? rc.tier : null;
    let magLimit = cfg && Number.isFinite(cfg.starMagLimit) ? cfg.starMagLimit : 6.0;
    let twinkleTier = !!(cfg && cfg.twinkle);
    let reducedMotion = !!deps.reducedMotion;
    let selection = null;
    let skyBlend = 0;
    let sunAltDeg = -90;
    let obscuration = 0;
    const tmpSize = new THREE.Vector2();
    const upS = new THREE.Vector3(0, 1, 0);
    const northS = new THREE.Vector3(0, 0, -1);
    const eastS = new THREE.Vector3(1, 0, 0);
    const southS = new THREE.Vector3();

    // --- Milky Way ------------------------------------------------------------------------------
    const M = EQJ_TO_GAL;
    // scene → galactic = M · Sᵀ, with eqj = (xs, −zs, ys).
    const toGal = new THREE.Matrix3().set(
        M[0], M[2], -M[1],
        M[3], M[5], -M[4],
        M[6], M[8], -M[7],
    );
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    blank.needsUpdate = true;
    const mwUniforms = {
        uMW: { value: blank },
        uMWSize: { value: new THREE.Vector2(1, 1) },
        uDetail: { value: 0 },
        uExposure: { value: 1 },
        uGain: { value: MW_GAIN_ORBIT },
        uToGal: { value: toGal },
        uSkyBlend: { value: 0 },
        uUp: { value: upS },
        uDisplay: { value: 1 },
        uDpr: { value: 1 },
    };
    const mwMaterial = new THREE.ShaderMaterial({
        name: 'sky.milkyway', uniforms: mwUniforms,
        vertexShader: MW_VERT, fragmentShader: MW_FRAG,
        side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending,
    });
    const mwGeometry = new THREE.SphereGeometry(1, 64, 32);
    const milkyWay = new THREE.Mesh(mwGeometry, mwMaterial);
    milkyWay.name = 'sky.milkyway';
    milkyWay.frustumCulled = false;
    milkyWay.renderOrder = -90;
    milkyWay.matrixAutoUpdate = false;
    group.add(milkyWay);
    let mwReady = false;

    // Procedural structure (B-spline lookup, star clouds, field stars, dust) on medium and high.
    function wantDetail() { return !!cfg && cfg.name !== 'low'; }
    function refreshDetail() {
        mwUniforms.uDetail.value = mwReady && wantDetail() ? 1 : 0;
    }
    function useMilkyWay(tex) {
        if (!tex) return;
        if (tex.image && tex.image.width > 1) {
            if (tex.wrapS !== THREE.RepeatWrapping) {
                tex.wrapS = THREE.RepeatWrapping;
                tex.needsUpdate = true;
            }
            mwUniforms.uMWSize.value.set(tex.image.width, tex.image.height);
            mwReady = true;
        }
        mwUniforms.uMW.value = tex;
        refreshDetail();
        if (rc && rc.invalidate) rc.invalidate();
    }
    let offMW = null;
    if (textures) {
        try {
            useMilkyWay(textures.get('milkyway'));
            offMW = textures.onReady('milkyway', useMilkyWay);
        } catch { /* placeholder stays */ }
    }

    // --- Stars ------------------------------------------------------------------------------------
    const starUniforms = {
        uMagLimit: { value: magLimit },
        uExposure: { value: 1 },
        uPx: { value: 1 },
        uZoom: { value: 1 },
        uHalo: { value: cfg && cfg.bloom ? 0.35 : 1.0 },
        uTwinkle: { value: 0 },
        uTime: { value: 0 },
        uSkyBlend: { value: 0 },
        uUp: { value: upS },
        uSaturation: { value: 0.85 },
        uDisplay: { value: 1 },
    };
    const starMaterial = new THREE.ShaderMaterial({
        name: 'sky.stars', uniforms: starUniforms,
        vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    let starGeometry = new THREE.BufferGeometry();
    const stars = new THREE.Points(starGeometry, starMaterial);
    stars.name = 'sky.stars';
    stars.frustumCulled = false;
    stars.renderOrder = -70;
    stars.matrixAutoUpdate = false;
    group.add(stars);
    let starMags = new Float32Array(0);

    function applyMagLimit() {
        starUniforms.uMagLimit.value = magLimit;
        // Stars are sorted brightest first, so the tier limit is just a draw range.
        let n = 0;
        while (n < starMags.length && starMags[n] <= magLimit + 0.001) n++;
        starGeometry.setDrawRange(0, n);
    }

    // --- Lines ------------------------------------------------------------------------------------
    const cons = createLineLayer({
        name: 'sky.constellations', capacity: 1024, color: [0.35, 0.50, 0.80], alpha: 0.28,
        halfWidthPx: 0.55, gapPx: 5.0, renderOrder: -80, defines: { HIGHLIGHT: '' },
    });
    cons.uniforms.uHighlightColor.value.setRGB(0.62, 0.78, 1.0);
    group.add(cons.mesh);
    let consSegCon = new Uint16Array(0);
    let consIau = [];
    let consCount = 0;
    let highlighted = '';
    const lastHighlightDir = new Float64Array([NaN, 0, 0]);

    const eqGrid = createLineLayer({
        name: 'sky.eqgrid', capacity: 5200, color: [0.3, 0.4, 0.6], alpha: 0.18, halfWidthPx: 0.5, renderOrder: -80,
    });
    group.add(eqGrid.mesh);
    const ecliptic = createLineLayer({
        name: 'sky.ecliptic', capacity: 200, color: [0.9, 0.7, 0.3], alpha: 0.35, halfWidthPx: 0.6, renderOrder: -80,
    });
    group.add(ecliptic.mesh);
    const altAz = createLineLayer({
        name: 'sky.altaz', capacity: 1700, color: [0.5, 0.7, 0.6], alpha: 0.16, halfWidthPx: 0.5, renderOrder: -80,
    });
    altAz.mesh.matrixAutoUpdate = false;
    group.add(altAz.mesh);

    buildStaticLines();

    function buildStaticLines() {
        const p = [0, 0, 0], q = [0, 0, 0];
        // Equatorial grid: RA every 15° (Dec −80…80 in 2° chords), Dec every 10° (2° chords).
        let i = 0;
        for (let ra = 0; ra < 360; ra += 15) {
            for (let dec = -80; dec < 80; dec += 2) {
                raDecToScene(ra, dec, p); raDecToScene(ra, dec + 2, q);
                putSeg(eqGrid, i++, p[0], p[1], p[2], q[0], q[1], q[2], ra % 90 === 0 ? 1.3 : 1);
            }
        }
        for (let dec = -80; dec <= 80; dec += 10) {
            for (let ra = 0; ra < 360; ra += 2) {
                raDecToScene(ra, dec, p); raDecToScene(ra + 2, dec, q);
                putSeg(eqGrid, i++, p[0], p[1], p[2], q[0], q[1], q[2], dec === 0 ? 2.0 : 1);
            }
        }
        eqGrid.setCount(i); eqGrid.commit();

        // Ecliptic: λ around the J2000 ecliptic, EQJ (cosλ, sinλ·cosε, sinλ·sinε) → scene (x, z, −y).
        const ce = Math.cos(OBLIQUITY_DEG * DEG), se = Math.sin(OBLIQUITY_DEG * DEG);
        i = 0;
        for (let l = 0; l < 360; l += 2) {
            const a = l * DEG, b = (l + 2) * DEG;
            putSeg(ecliptic, i++,
                Math.cos(a), Math.sin(a) * se, -Math.sin(a) * ce,
                Math.cos(b), Math.sin(b) * se, -Math.sin(b) * ce);
        }
        ecliptic.setCount(i); ecliptic.commit();

        // Alt-az grid in the local (east, up, south) frame: rings every 15°, azimuths every 30°.
        i = 0;
        for (let alt = 0; alt <= 75; alt += 15) {
            for (let az = 0; az < 360; az += 2) {
                altAzLocal(alt, az, p); altAzLocal(alt, az + 2, q);
                putSeg(altAz, i++, p[0], p[1], p[2], q[0], q[1], q[2], alt === 0 ? 2.4 : 1);
            }
        }
        for (let az = 0; az < 360; az += 30) {
            for (let alt = 0; alt < 80; alt += 2) {
                altAzLocal(alt, az, p); altAzLocal(alt + 2, az, q);
                putSeg(altAz, i++, p[0], p[1], p[2], q[0], q[1], q[2], az % 90 === 0 ? 1.6 : 1);
            }
        }
        altAz.setCount(i); altAz.commit();
    }

    // --- Catalog ----------------------------------------------------------------------------------
    function setCatalog(catalog) {
        const st = catalog && catalog.stars;
        const n = st && st.count > 0 && st.dirS && st.mag ? st.count : 0;
        const order = new Uint32Array(n);
        for (let k = 0; k < n; k++) order[k] = k;
        if (n) order.sort((a, b) => st.mag[a] - st.mag[b]);
        const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) {
            const j = order[k];
            pos[k * 3] = st.dirS[j * 3]; pos[k * 3 + 1] = st.dirS[j * 3 + 1]; pos[k * 3 + 2] = st.dirS[j * 3 + 2];
            mag[k] = st.mag[j];
            if (st.color) {
                col[k * 3] = st.color[j * 3]; col[k * 3 + 1] = st.color[j * 3 + 1]; col[k * 3 + 2] = st.color[j * 3 + 2];
            } else {
                col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = 1;
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
        g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
        const old = starGeometry;
        starGeometry = g;
        stars.geometry = g;
        old.dispose();
        starMags = mag;
        applyMagLimit();

        const c = catalog && catalog.cons;
        const segs = c && c.segments ? Math.floor(c.segments.length / 6) : 0;
        cons.ensure(segs);
        const src = segs ? c.segments : null;
        for (let k = 0; k < segs; k++) {
            const o = k * 6;
            putSeg(cons, k, src[o], src[o + 1], src[o + 2], src[o + 3], src[o + 4], src[o + 5], 1, 0);
        }
        consCount = segs;
        cons.setCount(segs);
        cons.commit();
        consSegCon = c && c.segCon ? c.segCon : new Uint16Array(segs);
        // IAU code per figure ('Ser' for both Serpens halves), as astronomy-engine reports it.
        consIau = (c && Array.isArray(c.list) ? c.list : []).map(e => (e && (e.iau || String(e.id || '').replace(/\d+$/, ''))) || '');
        highlighted = '';
        lastHighlightDir[0] = NaN;
        if (rc && rc.invalidate) rc.invalidate();
    }

    // --- Selected body's constellation highlight ----------------------------------------------
    function setHighlight(sym) {
        if (sym === highlighted) return;
        highlighted = sym;
        const st = cons.st;
        for (let k = 0; k < consCount; k++) {
            const on = sym !== '' && consIau[consSegCon[k]] === sym;
            st[k * 4] = on ? 2.2 : 1;
            st[k * 4 + 1] = on ? 1 : 0;
        }
        cons.commitStyle();
    }
    function updateHighlight(dirS) {
        if (!dirS || !consIau.length) { setHighlight(''); return; }
        const d0 = lastHighlightDir;
        // Only re-query when the body has moved noticeably (≈0.05°).
        if (d0[0] === d0[0] && dirS[0] * d0[0] + dirS[1] * d0[1] + dirS[2] * d0[2] > 0.9999996) return;
        d0[0] = dirS[0]; d0[1] = dirS[1]; d0[2] = dirS[2];
        let sym = '';
        try {
            const ra = Math.atan2(-dirS[2], dirS[0]) / DEG;
            const dec = Math.asin(Math.max(-1, Math.min(1, dirS[1]))) / DEG;
            sym = AE.Constellation((((ra % 360) + 360) % 360) / 15, dec).symbol || '';
        } catch { sym = ''; }
        setHighlight(sym);
    }

    if (deps.catalog) {
        try { setCatalog(deps.catalog); } catch { /* stays empty */ }
    }

    // --- RenderModule API ----------------------------------------------------------------------
    function apply(snap) {
        if (!snap || !snap.observer) return;
        const o = snap.observer;
        sunAltDeg = Number.isFinite(o.sunAltDeg) ? o.sunAltDeg : -90;
        obscuration = snap.eclipse && Number.isFinite(snap.eclipse.obscurationAtObserver)
            ? snap.eclipse.obscurationAtObserver : 0;
        upS.set(o.upS[0], o.upS[1], o.upS[2]);
        northS.set(o.northS[0], o.northS[1], o.northS[2]);
        eastS.set(o.eastS[0], o.eastS[1], o.eastS[2]);
        southS.copy(northS).negate();
        altAz.mesh.matrix.makeBasis(eastS, upS, southS);
        altAz.mesh.matrixWorldNeedsUpdate = true;
        if (selection && snap.bodies) {
            let b = null;
            for (let k = 0; k < snap.bodies.length; k++) if (snap.bodies[k].id === selection) { b = snap.bodies[k]; break; }
            updateHighlight(b ? b.dirS : null);
        } else if (highlighted !== '') {
            setHighlight('');
        }
    }

    function update(fi) {
        if (!fi) return;
        if (fi.exposure) {
            exposure.stars = fi.exposure.stars;
            exposure.milkyWay = fi.exposure.milkyWay;
        }
        skyBlend = Number.isFinite(fi.skyBlend) ? fi.skyBlend : 0;
        const cam = fi.camera || (rc && rc.camera);
        const r = rc && rc.renderer;
        let w = 1, h = 1, dpr = 1;
        if (r) {
            r.getDrawingBufferSize(tmpSize);
            w = tmpSize.x; h = tmpSize.y; dpr = r.getPixelRatio();
        }
        cons.setViewport(w, h, dpr);
        eqGrid.setViewport(w, h, dpr);
        ecliptic.setViewport(w, h, dpr);
        altAz.setViewport(w, h, dpr);

        const fov = cam && cam.fov ? cam.fov : 45;
        starUniforms.uPx.value = dpr;
        starUniforms.uZoom.value = Math.min(2.5, Math.max(1, Math.sqrt(60 / fov)));
        // Totality brings the brighter stars out even in daytime.
        const eclipseStars = 0.8 * smooth(0.97, 1.0, obscuration) * skyBlend;
        const starExp = Math.max(exposure.stars, eclipseStars);
        const display = skyViewExposure(sunAltDeg, skyBlend, obscuration);
        starUniforms.uExposure.value = starExp;
        starUniforms.uDisplay.value = display;
        mwUniforms.uDisplay.value = display;
        starUniforms.uSkyBlend.value = skyBlend;
        const tw = twinkleTier && !reducedMotion ? skyBlend : 0;
        starUniforms.uTwinkle.value = tw;
        starUniforms.uTime.value = Number.isFinite(fi.timeS) ? fi.timeS % 1000 : 0;
        mwUniforms.uExposure.value = exposure.milkyWay;
        mwUniforms.uDpr.value = Math.max(0.5, dpr);
        mwUniforms.uGain.value = MW_GAIN_ORBIT + (MW_GAIN_SKY - MW_GAIN_ORBIT) * skyBlend;
        mwUniforms.uSkyBlend.value = skyBlend;

        stars.visible = layers.stars && starExp > 0.001 && starGeometry.drawRange.count > 0;
        milkyWay.visible = layers.milkyWay && mwReady && exposure.milkyWay > 0.001;
        const e = Math.max(0, Math.min(1, starExp));
        cons.uniforms.uAlpha.value = 0.28 * Math.max(e, 0.15);
        cons.mesh.visible = layers.constellations && consCount > 0;
        eqGrid.uniforms.uAlpha.value = 0.18 * (0.5 + 0.5 * e);
        eqGrid.mesh.visible = layers.eqGrid;
        ecliptic.uniforms.uAlpha.value = 0.35 * (0.5 + 0.5 * e);
        ecliptic.mesh.visible = layers.ecliptic;
        altAz.uniforms.uAlpha.value = 0.16 * skyBlend;
        altAz.mesh.visible = layers.altAzGrid && skyBlend > 0.001;
    }

    function setLayers(l) {
        if (!l) return;
        for (const k of Object.keys(LAYER_DEFAULTS)) if (typeof l[k] === 'boolean') layers[k] = l[k];
    }

    function setViewMode(mode, blend) {
        if (Number.isFinite(blend)) skyBlend = blend;
    }

    function setSelection(id) {
        selection = id || null;
        lastHighlightDir[0] = NaN;
        if (!selection) setHighlight('');
    }

    function setQuality(c) {
        if (!c) return;
        cfg = c;
        if (Number.isFinite(c.starMagLimit)) magLimit = c.starMagLimit;
        twinkleTier = !!c.twinkle;
        starUniforms.uHalo.value = c.bloom ? 0.35 : 1.0;
        applyMagLimit();
        refreshDetail();
    }

    function setExposure(e) {
        if (!e) return;
        if (Number.isFinite(e.stars)) exposure.stars = e.stars;
        if (Number.isFinite(e.milkyWay)) exposure.milkyWay = e.milkyWay;
    }

    function setReducedMotion(on) { reducedMotion = !!on; }

    function dispose() {
        if (offMW) { try { offMW(); } catch { /* ignore */ } }
        starGeometry.dispose(); starMaterial.dispose();
        mwGeometry.dispose(); mwMaterial.dispose();
        cons.dispose(); eqGrid.dispose(); ecliptic.dispose(); altAz.dispose();
        blank.dispose();
    }

    return {
        object3d: group,
        apply, update, setLayers, setViewMode, setSelection, setQuality, setExposure,
        setCatalog, setReducedMotion, dispose,
    };
}
