/**
 * Meteors in sky view (ROADMAP meteor-showers): the radiants of the showers near their maximum and
 * illustrative meteors streaking away from them, plus a sporadic background.
 *
 *   createMeteors(rc, {clock, store, reducedMotion, onAnchors}) → RenderModule & {anchors(), stats()}
 *
 * Rates. Each snapshot sets every source's hourly rate for this observer: the shower's ZHR on the
 * date (astro/meteors.js zhrAt), the radiant's altitude and the limiting magnitude of this sky
 * (snap.skyglow: moonlight and light pollution; twilight), HR = ZHR·sin h·r^(lm − 6.5). The sporadic
 * background is SPORADIC_HR at a perfect sky.
 *
 * Which meteors. Simulated time is cut into BUCKET_MS buckets; a bucket's meteors (how many, a
 * Poisson draw, and each one's place, length, speed and magnitude) are a pure hash of the bucket,
 * the source and the meteor's index, so scrubbing, pausing and replaying give the same sky.
 *
 * Live (medium tier and up, the clock running, no reduced motion): a meteor is launched when
 * simulated time passes its instant, and then plays for 0.3–0.8 s of WALL-CLOCK time whatever the
 * clock rate, so a fast clock shows more meteors rather than shorter ones. Past LIVE_CAP_PER_S a
 * second the launches are thinned (rate × clock speed is capped), and above LIVE_MAX_RATE (1 h/s)
 * there are none. Frames are requested (rc.invalidate) only while a streak is in the air: between
 * meteors the sky is still and the loop idles, so a quiet night costs nothing.
 *
 * Composite (any tier; the clock paused, or reduced motion): the meteors of the last hour of
 * simulated time are drawn at once, star-aligned, as a stacked meteor photograph converging on
 * the radiant. It is static, so it needs no frames of its own.
 *
 * Geometry: every meteor runs along a great circle away from its radiant (a straight line in the
 * perspective projection), starting ψ 3°…100° from it, foreshortened (length ∝ sin ψ); only meteors
 * whose path stays above MIN_ALT_DEG are drawn. One instanced line segment per meteor
 * (sky.js createLineLayer, METEOR define: a bright head and a fading train), written in place; no
 * allocation per frame. The radiant marker is a ring with spokes and a label anchor.
 *
 * Everything drawn is illustrative: real meteors are random, and their true rates are in the
 * Events tab.
 * @module render/meteors
 */
import * as THREE from 'three';
import { createLineLayer } from './sky.js';
import {
    SHOWERS, SPORADIC_HR, SPORADIC_R, RADIANT_MARK_FRACTION, BUCKET_MS, solarLonFromScene, showerValid, zhrAt,
    radiantAt, meteorLimitMag, hourlyRate, hash01, poissonCount, meteorShape, sampleMagnitude, meteorAlpha,
} from '../astro/meteors.js';

const DEG = Math.PI / 180;
const NS = SHOWERS.length;                 // the sporadic source's index
/** Live streaks in the air at once, per tier (0 = no live meteors). */
const POOL = { low: 0, medium: 48, high: 64, max: 96 };
/** Composite capacity per tier. */
const COMPOSITE_CAP = { low: 96, medium: 192, high: 256, max: 256 };
const COMPOSITE_MS = 60 * 60e3;
/** Most launches per wall-clock second (the rate × clock speed is capped here). */
export const LIVE_CAP_PER_S = 2.5;
/** No meteors above this clock rate (the sky would be a blur of them). */
export const LIVE_MAX_RATE = 3600;
/** A frame that crosses more buckets than this was a jump: no launches for it (a backstop; a frame
 * whose sim advance is far beyond rate × wall time is one too). */
const MAX_BUCKETS = 400;
/** Paths must stay this high (degrees). */
const MIN_ALT_DEG = 8;
/** No meteors while the Sun is higher than this (the rates already fade through twilight). */
const SUN_MAX_DEG = -6;
/** Generated positions around the radiant that survive the horizon cut, roughly: rates are scaled up by its inverse. */
const ACCEPT_GAIN = 1.6;
const MAX_RADIANTS = 3;
const RING_SEGS = 16;
const SPOKES = 8;
const RING_DEG = 1.3, SPOKE_IN_DEG = 1.9, SPOKE_OUT_DEG = 3.3;
const RADIANT_COLOR = '#ffd28a';

const tierName = (cfg) => (cfg && typeof cfg === 'object' ? cfg.name : typeof cfg === 'string' ? cfg : 'medium');
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function basis(R, e1, e2) {
    // e1 ⊥ R in the plane of R and the scene's +Y (the J2000 pole), e2 = R × e1.
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(R[1]) > 0.99) { ax = 1; ay = 0; }
    let x = ay * R[2] - az * R[1], y = az * R[0] - ax * R[2], z = ax * R[1] - ay * R[0];
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    e1[0] = x; e1[1] = y; e1[2] = z;
    e2[0] = R[1] * z - R[2] * y; e2[1] = R[2] * x - R[0] * z; e2[2] = R[0] * y - R[1] * x;
}

/**
 * @param {any} rc render context
 * @param {{clock?:any, store?:any, reducedMotion?:boolean, onAnchors?:()=>void}} [deps]
 */
export function createMeteors(rc, deps = {}) {
    const { clock = null, store = null } = deps;
    const group = new THREE.Group();
    group.name = 'meteors';
    const refr = { uRefrUp: { value: new THREE.Vector3(0, 1, 0) }, uRefrK: { value: 0 } };
    const streaks = createLineLayer({
        name: 'meteors.streaks', capacity: 256, color: [1.0, 0.86, 0.62], alpha: 1, halfWidthPx: 1.15,
        renderOrder: -55, defines: { METEOR: '' }, blending: THREE.AdditiveBlending, refraction: refr,
    });
    streaks.uniforms.uHighlightColor.value.setRGB(0.72, 0.92, 1.0);
    const marks = createLineLayer({
        name: 'meteors.radiants', capacity: MAX_RADIANTS * (RING_SEGS + SPOKES), color: [1.0, 0.82, 0.55], alpha: 0.5,
        halfWidthPx: 0.7, renderOrder: -58, refraction: refr,
    });
    group.add(streaks.mesh, marks.mesh);
    // Hidden through their materials, never `visible`: three uploads a geometry the first time it
    // projects the object, and a layer hidden until a shower's first radiant or meteor of a time-lapse
    // would upload its buffers then.
    streaks.mesh.material.visible = false;
    marks.mesh.material.visible = false;

    // Sources: the showers and the sporadic background (index NS).
    const src = Array.from({ length: NS + 1 }, (_, i) => ({
        on: false, rateH: 0, zhr: 0, r: i < NS ? SHOWERS[i].r : SPORADIC_R, v: i < NS ? SHOWERS[i].v : 40,
        tint: i < NS ? clamp01((SHOWERS[i].v - 20) / 50) : 0.5, mark: false,
        dir: new Float64Array(3), e1: new Float64Array(3), e2: new Float64Array(3),
    }));
    const rd = { raDeg: 0, decDeg: 0 };
    const up = new Float64Array([0, 1, 0]);
    let sunAltDeg = -90;
    let lm = 6.5;
    let simNowMs = NaN;
    let layerOn = true;
    let skyBlend = 0;
    let tier = tierName(rc?.tier);
    let rm = !!deps.reducedMotion;
    let srcKey = '';

    // The live pool: per slot its start (wall s), duration, geometry and strength.
    const PMAX = 96;
    const pStart = new Float64Array(PMAX).fill(-1), pDur = new Float64Array(PMAX), pPsi = new Float64Array(PMAX), pLen = new Float64Array(PMAX);
    const pAlpha = new Float64Array(PMAX), pTint = new Float64Array(PMAX);
    const pR = new Float64Array(PMAX * 3), pT = new Float64Array(PMAX * 3);
    let poolCap = POOL[tier] ?? 0;
    let lastSim = NaN;
    let lastWallS = NaN;
    let liveCount = 0;
    let compositeCount = 0;
    let compositeKey = '';
    let launched = 0;

    // Radiant markers and their label anchors (live dirS vectors, rebuilt when the set changes).
    const markDir = Array.from({ length: MAX_RADIANTS }, () => new Float64Array(3));
    let anchorList = [];
    let markKey = '';

    // Scratch.
    const size = new THREE.Vector2();
    const shape = { offset: 0, psiDeg: 0, paDeg: 0, lenDeg: 0, durS: 0, u: 0 };
    const R = new Float64Array(3), E1 = new Float64Array(3), E2 = new Float64Array(3), T = new Float64Array(3);

    function invalidate() { try { rc?.invalidate?.(); } catch { /* never throw from a redraw request */ } }

    /** One meteor's geometry and strength into (R, T, shape, out); false when it is not drawn. */
    function makeMeteor(k, s, j, out) {
        const S = src[s];
        meteorShape(k, s, j, S.v, shape);
        if (s === NS) {
            // Sporadic: a radiant anywhere on the sphere.
            const z = 2 * hash01(k, s, j, 7) - 1, ph = 2 * Math.PI * hash01(k, s, j, 8), q = Math.sqrt(1 - z * z);
            R[0] = q * Math.cos(ph); R[1] = z; R[2] = q * Math.sin(ph);
            basis(R, E1, E2);
        } else {
            R[0] = S.dir[0]; R[1] = S.dir[1]; R[2] = S.dir[2];
            E1[0] = S.e1[0]; E1[1] = S.e1[1]; E1[2] = S.e1[2];
            E2[0] = S.e2[0]; E2[1] = S.e2[1]; E2[2] = S.e2[2];
        }
        const th = shape.paDeg * DEG, c = Math.cos(th), sn = Math.sin(th);
        T[0] = c * E1[0] + sn * E2[0]; T[1] = c * E1[1] + sn * E2[1]; T[2] = c * E1[2] + sn * E2[2];
        // Both ends above the cut.
        const minUp = Math.sin(MIN_ALT_DEG * DEG);
        for (let e = 0; e < 2; e++) {
            const a = (shape.psiDeg + e * shape.lenDeg) * DEG, ca = Math.cos(a), sa = Math.sin(a);
            const h = (R[0] * ca + T[0] * sa) * up[0] + (R[1] * ca + T[1] * sa) * up[1] + (R[2] * ca + T[2] * sa) * up[2];
            if (h < minUp) return false;
        }
        out.alpha = meteorAlpha(sampleMagnitude(shape.u, S.r, lm));
        out.tint = S.tint;
        return true;
    }
    const made = { alpha: 0, tint: 0 };

    /** Writes the arc ψ ∈ [a, b] (degrees) of meteor (R, T) as segment i. */
    function putArc(layer, i, Rv, ro, Tv, to, a, b, alpha, tint, pa, pb) {
        const ab = layer.ab, st = layer.st, o = i * 6, so = i * 4;
        const ca = Math.cos(a * DEG), sa = Math.sin(a * DEG), cb = Math.cos(b * DEG), sb = Math.sin(b * DEG);
        for (let c = 0; c < 3; c++) {
            ab[o + c] = Rv[ro + c] * ca + Tv[to + c] * sa;
            ab[o + 3 + c] = Rv[ro + c] * cb + Tv[to + c] * sb;
        }
        st[so] = alpha; st[so + 1] = tint; st[so + 2] = pa; st[so + 3] = pb;
    }

    // ---------------------------------------------------------------------------------- apply
    function apply(snap) {
        if (!snap || !snap.observer) return;
        const o = snap.observer;
        up[0] = o.upS[0]; up[1] = o.upS[1]; up[2] = o.upS[2];
        refr.uRefrUp.value.set(up[0], up[1], up[2]);
        sunAltDeg = Number.isFinite(o.sunAltDeg) ? o.sunAltDeg : -90;
        simNowMs = snap.tMs;
        const zenithNl = snap.skyglow && Number.isFinite(snap.skyglow.zenithNl) ? snap.skyglow.zenithNl : 54;
        lm = meteorLimitMag(sunAltDeg, zenithNl);
        const lam = snap.sunDirS ? solarLonFromScene(snap.sunDirS) : NaN;
        const year = new Date(snap.tMs).getUTCFullYear();
        let key = '';
        let nMark = 0;
        for (let i = 0; i < NS; i++) {
            const sh = SHOWERS[i], S = src[i];
            const zhr = Number.isFinite(lam) && showerValid(sh, year) ? zhrAt(sh, lam) : 0;
            S.zhr = zhr;
            S.on = zhr >= 0.5;
            S.mark = false;
            if (!S.on) { S.rateH = 0; continue; }
            radiantAt(sh, lam, rd);
            const a = rd.raDeg * DEG, d = rd.decDeg * DEG;
            S.dir[0] = Math.cos(d) * Math.cos(a); S.dir[1] = Math.sin(d); S.dir[2] = -Math.cos(d) * Math.sin(a);
            basis(S.dir, S.e1, S.e2);
            const alt = Math.asin(Math.max(-1, Math.min(1, S.dir[0] * up[0] + S.dir[1] * up[1] + S.dir[2] * up[2]))) / DEG;
            S.rateH = hourlyRate(zhr, alt, lm, sh.r);
            if (zhr >= RADIANT_MARK_FRACTION * sh.zhr && nMark < MAX_RADIANTS) {
                S.mark = true;
                markDir[nMark][0] = S.dir[0]; markDir[nMark][1] = S.dir[1]; markDir[nMark][2] = S.dir[2];
                nMark++;
                key += sh.id;
            }
        }
        const sp = src[NS];
        sp.on = true;
        sp.rateH = SPORADIC_HR * Math.pow(SPORADIC_R, Math.min(6.5, lm) - 6.5);
        srcKey = `${key}|${Math.round(lm * 4)}`;
        if (key !== markKey) {
            markKey = key;
            markLam = lam;
            buildMarks(nMark);
        } else if (key && Math.abs(((lam - markLam + 540) % 360) - 180) > 0.25) {
            // The radiants drift about a degree a day: redraw the rings (the labels' vectors are live).
            markLam = lam;
            drawRings();
            invalidate();
        }
        // The radiant labels follow the night (anchors()); tell the feed when that flips.
        const night = sunAltDeg < -4;
        if (night !== lastNight) {
            lastNight = night;
            if (anchorList.length) { try { deps.onAnchors?.(); } catch { /* ignore */ } }
        }
    }
    let lastNight = false;
    let markLam = NaN;

    /** The marked radiants' rings and spokes. */
    function drawRings() {
        let seg = 0;
        for (let i = 0; i < NS; i++) {
            const S = src[i];
            if (!S.mark) continue;
            for (let k = 0; k < RING_SEGS; k++) {
                const a0 = (k / RING_SEGS) * 360, a1 = ((k + 1) / RING_SEGS) * 360;
                ringPoint(S, RING_DEG, a0, T);
                const x0 = T[0], y0 = T[1], z0 = T[2];
                ringPoint(S, RING_DEG, a1, T);
                putRaw(marks, seg++, x0, y0, z0, T[0], T[1], T[2], 1);
            }
            for (let k = 0; k < SPOKES; k++) {
                const pa = (k / SPOKES) * 360 + 22.5;
                ringPoint(S, SPOKE_IN_DEG, pa, T);
                const x0 = T[0], y0 = T[1], z0 = T[2];
                ringPoint(S, SPOKE_OUT_DEG, pa, T);
                putRaw(marks, seg++, x0, y0, z0, T[0], T[1], T[2], 0.8);
            }
        }
        marks.setCount(seg);
        marks.commit();
    }

    /** The rings and the label anchors, when the set of marked radiants changes. */
    function buildMarks(n) {
        anchorList = [];
        let m = 0;
        drawRings();
        for (let i = 0; i < NS && m < n; i++) {
            const S = src[i];
            if (!S.mark) continue;
            const sh = SHOWERS[i];
            anchorList.push({
                id: `radiant:${sh.id}`, text: `${sh.name} radiant`, kind: 'trail', priority: 58, color: RADIANT_COLOR,
                dirS: markDir[m], offsetPx: [10, -12], ariaLabel: `${sh.name} radiant: the shower’s meteors seem to come from here`,
                interactive: false,
            });
            m++;
        }
        try { deps.onAnchors?.(); } catch { /* the labels refresh on their own later */ }
        invalidate();
    }

    function ringPoint(S, rDeg, paDeg, out) {
        const r = rDeg * DEG, p = paDeg * DEG, cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p);
        for (let c = 0; c < 3; c++) out[c] = S.dir[c] * cr + (S.e1[c] * cp + S.e2[c] * sp) * sr;
    }

    function putRaw(layer, i, ax, ay, az, bx, by, bz, alpha) {
        const ab = layer.ab, st = layer.st, o = i * 6, so = i * 4;
        ab[o] = ax; ab[o + 1] = ay; ab[o + 2] = az; ab[o + 3] = bx; ab[o + 4] = by; ab[o + 5] = bz;
        st[so] = alpha; st[so + 1] = 0; st[so + 2] = 0; st[so + 3] = 0;
    }

    // ---------------------------------------------------------------------------------- live
    const meanIn = (s) => (src[s].rateH * ACCEPT_GAIN * BUCKET_MS) / 3.6e6;

    function launch(k, s, j, nowS) {
        let slot = -1;
        for (let i = 0; i < poolCap; i++) if (pStart[i] < 0) { slot = i; break; }
        if (slot < 0) return;
        if (!makeMeteor(k, s, j, made)) return;
        pStart[slot] = nowS;
        pDur[slot] = shape.durS;
        pPsi[slot] = shape.psiDeg;
        pLen[slot] = shape.lenDeg;
        pAlpha[slot] = made.alpha;
        pTint[slot] = made.tint;
        for (let c = 0; c < 3; c++) { pR[slot * 3 + c] = R[c]; pT[slot * 3 + c] = T[c]; }
        launched++;
    }

    function spawn(fromMs, toMs, simRate, nowS) {
        const a = Math.min(fromMs, toMs), b = Math.max(fromMs, toMs);
        const k0 = Math.floor(a / BUCKET_MS), k1 = Math.floor(b / BUCKET_MS);
        if (k1 - k0 > MAX_BUCKETS) return;
        let perS = 0;
        for (let s = 0; s <= NS; s++) if (src[s].on) perS += (src[s].rateH * ACCEPT_GAIN) / 3600;
        const keep = Math.min(1, LIVE_CAP_PER_S / Math.max(1e-9, perS * Math.abs(simRate)));
        for (let k = k0; k <= k1; k++) {
            for (let s = 0; s <= NS; s++) {
                if (!src[s].on || !(src[s].rateH > 0)) continue;
                const n = poissonCount(meanIn(s), hash01(k, s, 0x7fff, 0));
                for (let j = 0; j < n; j++) {
                    const tj = (k + hash01(k, s, j, 1)) * BUCKET_MS;
                    if (!(tj > a && tj <= b)) continue;
                    if (hash01(k, s, j, 9) >= keep) continue;
                    launch(k, s, j, nowS);
                }
            }
        }
    }

    function drawLive(nowS) {
        let n = 0;
        for (let i = 0; i < poolCap; i++) {
            if (pStart[i] < 0) continue;
            const tau = (nowS - pStart[i]) / pDur[i];
            if (tau >= 1 || tau < 0) { pStart[i] = -1; continue; }
            // The head runs the path decelerating a little; the train trails 40 % behind it.
            const L = pLen[i];
            const head = L * (1 - Math.pow(1 - tau, 1.3));
            const tail = Math.max(0, head - 0.4 * L);
            const env = clamp01(tau / 0.12) * (1 - clamp01((tau - 0.7) / 0.3)) * (0.7 + 0.6 * tau);
            putArc(streaks, n++, pR, i * 3, pT, i * 3, pPsi[i] + tail, pPsi[i] + head, Math.min(2.5, pAlpha[i] * env * 1.4), pTint[i], 0, 1);
        }
        liveCount = n;
        return n;
    }

    // ---------------------------------------------------------------------------------- composite
    function buildComposite() {
        const cap = Math.min(streaks.capacity, COMPOSITE_CAP[tier] ?? 128);
        const kB = Math.floor(simNowMs / BUCKET_MS), kA = Math.floor((simNowMs - COMPOSITE_MS) / BUCKET_MS);
        let expected = 0;
        for (let s = 0; s <= NS; s++) if (src[s].on) expected += meanIn(s) * (kB - kA + 1);
        const keep = Math.min(1, (0.8 * cap) / Math.max(1e-9, expected));
        let n = 0;
        for (let k = kA; k <= kB && n < cap; k++) {
            for (let s = 0; s <= NS && n < cap; s++) {
                if (!src[s].on || !(src[s].rateH > 0)) continue;
                const cnt = poissonCount(meanIn(s), hash01(k, s, 0x7fff, 0));
                for (let j = 0; j < cnt && n < cap; j++) {
                    if ((k + hash01(k, s, j, 1)) * BUCKET_MS > simNowMs) continue;
                    if (hash01(k, s, j, 9) >= keep) continue;
                    if (!makeMeteor(k, s, j, made)) continue;
                    putArc(streaks, n++, R, 0, T, 0, shape.psiDeg, shape.psiDeg + shape.lenDeg, Math.min(2, made.alpha * 1.7), made.tint, 0.1, 1);
                }
            }
        }
        compositeCount = n;
        streaks.setCount(n);
        streaks.commit();
    }

    function clearStreaks() {
        if (liveCount || compositeCount) {
            streaks.setCount(0);
            streaks.commit();
        }
        liveCount = 0;
        compositeCount = 0;
        compositeKey = '';
        pStart.fill(-1);
    }

    // ---------------------------------------------------------------------------------- update
    function update(fi) {
        if (!fi) return;
        skyBlend = Number.isFinite(fi.skyBlend) ? fi.skyBlend : 0;
        refr.uRefrK.value = clamp01(skyBlend);
        const r = rc && rc.renderer;
        if (r) {
            r.getDrawingBufferSize(size);
            const dpr = r.getPixelRatio();
            streaks.setViewport(size.x, size.y, dpr);
            marks.setViewport(size.x, size.y, dpr);
        }
        const st = store?.get?.();
        const exposing = !!st?.ui?.expose;
        const reduced = rm || !!st?.status?.reducedMotion;
        const sky = layerOn && skyBlend > 0.5;
        const dark = sunAltDeg < SUN_MAX_DEG;
        const stars = fi.exposure && Number.isFinite(fi.exposure.stars) ? clamp01(fi.exposure.stars * 1.5) : 1;
        marks.mesh.material.visible = sky && !exposing && markKey !== '' && sunAltDeg < -4;
        marks.uniforms.uAlpha.value = 0.5 * clamp01((skyBlend - 0.5) / 0.3);
        streaks.uniforms.uAlpha.value = stars;

        const simMs = Number.isFinite(clock?.tMs) ? clock.tMs : simNowMs;
        const rate = clock && clock.playing && Number.isFinite(clock.rate) ? clock.rate : 0;
        const nowS = Number.isFinite(fi.timeS) ? fi.timeS : performance.now() / 1000;
        const live = sky && dark && poolCap > 0 && !reduced && rate !== 0 && Math.abs(rate) <= LIVE_MAX_RATE;
        const composite = sky && dark && !live && (rate === 0 || reduced) && (COMPOSITE_CAP[tier] ?? 0) > 0;

        if (live) {
            if (compositeCount) { streaks.setCount(0); compositeCount = 0; compositeKey = ''; }
            if (Number.isFinite(lastSim) && simMs !== lastSim) {
                // A step or a scrub while playing moves sim time far beyond what the rate explains in
                // the wall time since the last update: that interval is skipped, not launched at once.
                const wallMs = Number.isFinite(lastWallS) ? Math.max(0, nowS - lastWallS) * 1000 : 0;
                if (Math.abs(simMs - lastSim) <= 2 * Math.abs(rate) * wallMs + BUCKET_MS) spawn(lastSim, simMs, rate, nowS);
            }
            lastSim = simMs;
            lastWallS = nowS;
            const n = drawLive(nowS);
            streaks.setCount(n);
            if (n) streaks.commit();
            streaks.mesh.material.visible = n > 0;
            if (n) invalidate();
            return;
        }
        lastSim = simMs;
        lastWallS = nowS;
        if (liveCount) { pStart.fill(-1); liveCount = 0; streaks.setCount(0); }
        if (composite) {
            const key = `${Math.floor(simMs / BUCKET_MS)}|${srcKey}|${up[0].toFixed(3)},${up[1].toFixed(3)},${up[2].toFixed(3)}|${tier}`;
            if (key !== compositeKey) {
                compositeKey = key;
                simNowMs = simMs;
                buildComposite();
            }
            streaks.mesh.material.visible = compositeCount > 0;
        } else {
            if (compositeCount) clearStreaks();
            streaks.mesh.material.visible = false;
        }
    }

    return {
        object3d: group,
        apply,
        update,
        setLayers(l) {
            if (l && typeof l.meteors === 'boolean' && l.meteors !== layerOn) {
                layerOn = l.meteors;
                if (!layerOn) clearStreaks();
                try { deps.onAnchors?.(); } catch { /* ignore */ }
                invalidate();
            }
        },
        setViewMode(mode, blend) { if (Number.isFinite(blend)) skyBlend = blend; },
        setQuality(cfg) {
            tier = tierName(cfg);
            poolCap = Math.min(PMAX, POOL[tier] ?? 0);
            clearStreaks();
        },
        setReducedMotion(on) { rm = !!on; },
        /** Label anchors for the marked radiants (sky view; the labels feed appends them). */
        anchors() { return layerOn && sunAltDeg < -4 ? anchorList : []; },
        /** Diagnostics: streaks drawn, the marked radiants and each active source's hourly rate. */
        stats() {
            const rates = {};
            for (let i = 0; i <= NS; i++) if (src[i].on) rates[i < NS ? SHOWERS[i].id : 'sporadic'] = Math.round(src[i].rateH * 10) / 10;
            return { live: liveCount, composite: compositeCount, launched, radiants: anchorList.map((a) => a.id.slice(8)), lm: Math.round(lm * 100) / 100, rates };
        },
        dispose() { streaks.dispose(); marks.dispose(); },
    };
}
