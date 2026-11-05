/**
 * The body card's eyepiece portrait: the selected body as a small telescope shows it now, drawn on
 * a 2D canvas only when its key changes (so it also works in text mode, without WebGL).
 *
 * - Moon: the real lunar map (assets/textures/moon_1024.jpg through `new Image`, the 3D loader may
 *   never run) at the true phase, libration and orientation, Lommel–Seeliger lit, with a hint of
 *   earthshine; the caption names the libration's direction and the limb feature it favours.
 * - Jupiter: the oblate, schematically banded globe with its four moons at their true side and
 *   order (logarithmic spacing beyond the limb, as on the globe's medallion), labelled, with moons
 *   in front of the disc and their shadows on it; moons behind Jupiter or in its shadow are listed.
 * - Saturn: the rings at the true opening, with the globe's shadow on them and theirs on the globe.
 * - Mercury, Venus, Mars: the true phase (Mars with its albedo markings at the real central
 *   meridian); Uranus and Neptune: tinted discs with the pole where it is.
 *
 * Same geometry as the medallions (astro/disc.js: planet north up, so on a north-up sky east is
 * left) and the same shading terms as PLANET_CHUNK (render/shaders/planets.glsl.js), ported to JS
 * here because js/ui never imports js/render. The size is magnified, not to a common scale.
 *
 * @module ui/eyepiece
 */
import { BODIES, BODY_INDEX } from '../astro/bodies.js';
import {
    SHAPES, MARS_SPOTS, createDiscFrame, createDiscView, discFrame, discView, toFrame, compressRadius, ringAt, grsLongitudeDeg,
} from '../astro/disc.js';
import {
    GALILEAN, MOON_TRANSIT, MOON_OCCULTED, MOON_ECLIPSED, MOON_SHADOW, bestLimbFeature, librationDirection, saturnEdgeOn,
} from '../astro/moons.js';
import { h, setText } from './dom.js';
import { t, N_, dec, dateText } from '../core/i18n.js';

const W = 320;
const H = 148;
const MOON_TEX_URL = 'assets/textures/moon_1024.jpg';
/** Globe radius (CSS px) per body on the portrait. */
const RADIUS = { moon: 62, mercury: 48, venus: 52, mars: 50, jupiter: 30, saturn: 29, uranus: 40, neptune: 40 };
const KIND = { mercury: 0, venus: 1, mars: 2, jupiter: 3, saturn: 4, uranus: 5, neptune: 6 };
const DEG = Math.PI / 180;

// Mars's albedo features as unit vectors (astro/disc.js MARS_SPOTS, as the shader builds them).
const MARS_DIRS = MARS_SPOTS.map(([lon, lat, r, k]) => [Math.cos(lat * DEG) * Math.cos(lon * DEG),
    Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG), 1 / (2 * (r * DEG) ** 2), k]);

// ---------------------------------------------------------------- the lunar map (shared, lazy)

let moonTex = null;          // {w, h, data} once loaded
let moonTexState = 'idle';   // 'idle' | 'loading' | 'ready' | 'failed'
const moonTexWaiters = new Set();

function loadMoonTexture() {
    if (moonTexState !== 'idle' || typeof Image === 'undefined' || typeof document === 'undefined') return;
    moonTexState = 'loading';
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
        try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0);
            moonTex = { w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
            moonTexState = 'ready';
        } catch {
            moonTexState = 'failed';
        }
        for (const cb of moonTexWaiters) cb();
    };
    img.onerror = () => {
        moonTexState = 'failed';
        for (const cb of moonTexWaiters) cb();
    };
    img.src = MOON_TEX_URL;
}

// ---------------------------------------------------------------- shading (mirrors PLANET_CHUNK)

function hash(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
}
function noise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let ux = x - ix, uy = y - iy;
    ux = ux * ux * (3 - 2 * ux);
    uy = uy * uy * (3 - 2 * uy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}
const sstep = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
const band = (x, a, b, w) => sstep(a - w, a + w, x) * (1 - sstep(b - w, b + w, x));
function mix3(c, d, f, out) {
    out[0] = c[0] + (d[0] - c[0]) * f; out[1] = c[1] + (d[1] - c[1]) * f; out[2] = c[2] + (d[2] - c[2]) * f;
    return out;
}

const ALB = [0, 0, 0];
const C_ZONE = [0.93, 0.88, 0.78], C_BELT = [0.60, 0.44, 0.32], C_TAN = [0.76, 0.65, 0.53], C_POLE = [0.62, 0.60, 0.58];
const C_TAN2 = C_TAN.map((x) => x * 0.97), C_GRS = [0.82, 0.48, 0.34];

function albedo(kind, nb, lat, lon, grsLon) {
    const c = ALB;
    if (kind === 0) {
        const m = 0.86 + 0.28 * noise(lon * 0.12, lat * 0.12);
        c[0] = 0.62 * m; c[1] = 0.58 * m; c[2] = 0.55 * m;
    } else if (kind === 1) {
        c[0] = 1.0; c[1] = 0.96; c[2] = 0.86;
    } else if (kind === 2) {
        c[0] = 0.78; c[1] = 0.43; c[2] = 0.24;
        let dark = 0, bright = 0;
        for (const s of MARS_DIRS) {
            const w = Math.exp((nb[0] * s[0] + nb[1] * s[1] + nb[2] * s[2] - 1) * s[3]);
            if (s[4] > 0) dark = Math.max(dark, s[4] * w); else bright = Math.max(bright, -s[4] * w);
        }
        mix3(c, [0.40, 0.25, 0.17], Math.min(0.85, dark), c);
        mix3(c, [0.92, 0.66, 0.46], Math.min(0.6, bright), c);
        const cap = Math.min(1, sstep(71, 77, lat) + sstep(73, 80, -lat));
        mix3(c, [0.96, 0.95, 0.94], cap, c);
    } else if (kind === 3) {
        const la = lat + 1.8 * (noise(lon * 0.08, lat * 0.32) - 0.5);
        c[0] = C_ZONE[0]; c[1] = C_ZONE[1]; c[2] = C_ZONE[2];
        mix3(c, C_BELT, band(la, 7, 18, 1.6), c);
        mix3(c, C_BELT, band(la, -20, -7, 1.6), c);
        mix3(c, C_TAN, band(la, 24, 31, 1.6), c);
        mix3(c, C_TAN, band(la, -34, -27, 1.6), c);
        mix3(c, C_TAN2, band(Math.abs(la), 37, 44, 2), c);
        mix3(c, C_POLE, sstep(46, 62, Math.abs(la)), c);
        const dl = ((lon - grsLon + 540) % 360) - 180;
        const e = (dl / 7.5) ** 2 + ((lat + 22.4) / 4.6) ** 2;
        mix3(c, C_GRS, 1 - sstep(0.55, 1, e), c);
    } else if (kind === 4) {
        const la = lat + 0.8 * (noise(lon * 0.05, lat * 0.25) - 0.5);
        c[0] = 0.90; c[1] = 0.82; c[2] = 0.62;
        mix3(c, [0.80, 0.69, 0.49], band(Math.abs(la), 11, 22, 2.5), c);
        mix3(c, [0.86, 0.77, 0.58], 0.6 * band(Math.abs(la), 28, 40, 3), c);
        mix3(c, [0.62, 0.66, 0.66], sstep(56, 74, Math.abs(la)), c);
    } else if (kind === 5) {
        const k = 1 + 0.08 * sstep(40, 80, lat);
        c[0] = 0.45 * k; c[1] = 0.78 * k; c[2] = 0.86 * k;
    } else {
        const k = 1 - 0.06 * band(lat, -30, -18, 3);
        c[0] = 0.30 * k; c[1] = 0.45 * k; c[2] = 0.95 * k;
    }
    return c;
}

/** Display transfer: a gentle shoulder (like the 3D view's tone map) and sRGB encoding, 0…255. */
function toByte(x) {
    const y = x / (1 + 0.25 * x) * 1.2;
    const s = y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(Math.max(y, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(s * 255)));
}

const NB = [0, 0, 0];
const RT = [0, 0];

/**
 * Shades one portrait pixel at (x, y) (equatorial radii, frame coordinates) into out [r, g, b, a]
 * (linear, straight alpha). Mirrors planetShade (PLANET_CHUNK), moons aside (drawn as vectors).
 */
function shadePlanet(x, y, aa, kind, v, oblate, moons, grsLon, out) {
    const p = v.pole, q = v.prime, L = v.light;
    const kf = 1 / ((1 - oblate) * (1 - oblate)) - 1;
    const stretch = 1 / (1 - oblate);
    // Spheroid hit (plSpheroid).
    const a = x * p[0] + y * p[1];
    const A = 1 + kf * p[2] * p[2];
    const B = 2 * kf * a * p[2];
    const C = x * x + y * y + kf * a * a - 1;
    const D = B * B - 4 * A * C;
    const g = D / (4 * A);
    const zg = (-B + Math.sqrt(Math.max(D, 0))) / (2 * A);
    const aG = Math.min(1, Math.max(0, 0.5 + g / (2 * Math.max(Math.hypot(x, y), 0.5) * aa)));
    let r = 0, gg = 0, b = 0;
    if (g > -4 * aa) {
        const xp = x * p[0] + y * p[1] + zg * p[2];
        let nx = x + kf * xp * p[0], ny = y + kf * xp * p[1], nz = zg + kf * xp * p[2];
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const ex = p[1] * q[2] - p[2] * q[1], ey = p[2] * q[0] - p[0] * q[2], ez = p[0] * q[1] - p[1] * q[0];
        NB[0] = nx * q[0] + ny * q[1] + nz * q[2];
        NB[1] = nx * ex + ny * ey + nz * ez;
        NB[2] = nx * p[0] + ny * p[1] + nz * p[2];
        const lat = Math.asin(Math.max(-1, Math.min(1, NB[2]))) / DEG;
        const lon = Math.atan2(NB[1], NB[0] + 1e-7) / DEG;
        const mu0 = nx * L[0] + ny * L[1] + nz * L[2];
        const mu = Math.max(nz, 0);
        const alb = albedo(kind, NB, lat, lon, grsLon);
        let lit;
        if (kind === 0) lit = 2 * Math.max(mu0, 0) / (Math.max(mu0, 0) + mu + 1e-3);
        else if (kind === 1) lit = Math.pow(Math.max(mu0, 0), 0.75);
        else lit = Math.max(mu0, 0) * (0.62 + 0.38 * mu);
        lit *= sstep(-aa, aa, mu0);
        const lp = L[0] * p[0] + L[1] * p[1] + L[2] * p[2];
        if (kind === 4 && Math.abs(lp) > 1e-4) {
            const s = -xp / lp;
            if (s > 0) {
                ringAt(Math.hypot(x + s * L[0], y + s * L[1], zg + s * L[2]), RT);
                lit *= Math.exp(-RT[0] / Math.max(Math.abs(lp), 0.05));
            }
        }
        if (kind === 3 && moons) {
            for (let k = 0; k < 4; k++) {
                const sh = moons.shadow[k];
                if (!sh) continue;
                const rr = Math.max(sh[2], 0.8 * moons.dotPx * aa);
                lit *= 1 - 0.92 * (1 - sstep(rr - aa, rr + aa, Math.hypot(x - sh[0], y - sh[1])));
            }
        }
        r = alb[0] * (lit + 0.006); gg = alb[1] * (lit + 0.006); b = alb[2] * (lit + 0.006);
    }
    let alpha = aG;
    if (kind === 4) {
        const pz = p[2];
        const pzc = (pz < 0 ? -1 : 1) * Math.max(Math.abs(pz), aa);
        const zr = -(x * p[0] + y * p[1]) / pzc;
        ringAt(Math.hypot(x, y, zr), RT);
        if (RT[0] > 0) {
            const slant = Math.max(Math.abs(pz), 0.02);
            const aR = (1 - Math.exp(-RT[0] / slant)) * Math.abs(pz) / Math.max(Math.abs(pz), aa);
            const lp = L[0] * p[0] + L[1] * p[1] + L[2] * p[2];
            let I = lp * pz > 0 ? RT[1] * (0.55 + 0.45 * Math.sqrt(Math.abs(lp))) : RT[1] * 0.9 * Math.exp(-RT[0]);
            const lx = L[0] + (stretch - 1) * lp * p[0], ly = L[1] + (stretch - 1) * lp * p[1], lz = L[2] + (stretch - 1) * lp * p[2];
            const AA = lx * lx + ly * ly + lz * lz, BB = 2 * (x * lx + y * ly + zr * lz), CC = x * x + y * y + zr * zr - 1;
            if (BB < 0) I *= 1 - sstep(-0.02, 0.02, (BB * BB - 4 * AA * CC) / (4 * AA));
            const cr = 0.92 * (I + 0.01), cg = 0.86 * (I + 0.01), cb = 0.72 * (I + 0.01);
            const front = g <= 0 || zr > zg;
            let na;
            if (front) {
                na = aR + aG * (1 - aR);
                r = (cr * aR + r * aG * (1 - aR)) / Math.max(na, 1e-4);
                gg = (cg * aR + gg * aG * (1 - aR)) / Math.max(na, 1e-4);
                b = (cb * aR + b * aG * (1 - aR)) / Math.max(na, 1e-4);
            } else {
                na = aG + aR * (1 - aG);
                r = (r * aG + cr * aR * (1 - aG)) / Math.max(na, 1e-4);
                gg = (gg * aG + cg * aR * (1 - aG)) / Math.max(na, 1e-4);
                b = (b * aG + cb * aR * (1 - aG)) / Math.max(na, 1e-4);
            }
            alpha = na;
        }
    }
    out[0] = r; out[1] = gg; out[2] = b; out[3] = alpha;
    return out;
}

/** The Moon: textured orthographic sphere, Lommel–Seeliger lit, earthshine on the night side. */
function shadeMoon(x, y, aa, v, out) {
    const r2 = x * x + y * y;
    const rr = Math.sqrt(r2);
    const alpha = Math.min(1, Math.max(0, 0.5 + (1 - rr) / aa));
    if (alpha <= 0) { out[3] = 0; return out; }
    const z = Math.sqrt(Math.max(0, 1 - r2));
    const p = v.pole, q = v.prime, L = v.light;
    const ex = p[1] * q[2] - p[2] * q[1], ey = p[2] * q[0] - p[0] * q[2], ez = p[0] * q[1] - p[1] * q[0];
    const bx = x * q[0] + y * q[1] + z * q[2], by = x * ex + y * ey + z * ez, bz = x * p[0] + y * p[1] + z * p[2];
    let alb = 0.55;
    if (moonTex) {
        const lat = Math.asin(Math.max(-1, Math.min(1, bz)));
        const lon = Math.atan2(by, bx);
        const u = 0.5 + lon / (2 * Math.PI), w = 0.5 - lat / Math.PI;
        const tx = Math.min(moonTex.w - 1, Math.max(0, Math.floor(u * moonTex.w)));
        const ty = Math.min(moonTex.h - 1, Math.max(0, Math.floor(w * moonTex.h)));
        const o = (ty * moonTex.w + tx) * 4;
        const s = (moonTex.data[o] + moonTex.data[o + 1] + moonTex.data[o + 2]) / (3 * 255);
        alb = Math.pow(s, 2.2) * 1.6;
    }
    const mu0 = x * L[0] + y * L[1] + z * L[2];
    const lit = 2 * Math.max(mu0, 0) / (Math.max(mu0, 0) + z + 1e-3) * sstep(-aa, aa, mu0);
    const v0 = alb * (lit + 0.012);
    out[0] = v0 * 1.0; out[1] = v0 * 0.99; out[2] = v0 * 0.96; out[3] = alpha;
    return out;
}

// ---------------------------------------------------------------- captions

function compassOrder(items) {
    return items.slice().sort((p, q) => p.x - q.x);
}

function monthYear(ms) {
    const d = new Date(ms);
    return dateText({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: 1, wd: 0 }, { month: 'short', year: 'numeric' });
}

/**
 * Creates the eyepiece figure.
 * @returns {{el:HTMLElement, update(snap:any, id:string):void, readonly key:string}}
 */
export function createEyepiece() {
    const canvas = h('canvas', { class: 'eyepiece__cv', width: W, height: H, role: 'img', 'aria-label': '' });
    const caption = h('p', { class: 'eyepiece__cap' });
    const note = h('p', { class: 'eyepiece__note' });
    const el = h('figure', { class: 'eyepiece', hidden: true }, canvas, caption, note);
    const frame = createDiscFrame();
    const view = createDiscView();
    const px = [0, 0, 0, 0];
    const tmp = new Float64Array(3);
    let key = '';
    let lastSnap = null;
    let lastId = null;

    const redraw = () => { key = ''; if (lastSnap && lastId) update(lastSnap, lastId); };
    moonTexWaiters.add(redraw);

    function moonsFor(snap, R) {
        const g = snap.galilean;
        if (!g) return null;
        const out = { list: [], shadow: [null, null, null, null], dotPx: 1.6 };
        GALILEAN.forEach((m, k) => {
            toFrame(frame, g.offS, tmp, 0, k * 3);
            const r = Math.hypot(tmp[0], tmp[1]);
            const c = r > 1 ? compressRadius(r) / r : 1;
            const f = g.state[k];
            out.list.push({ m, x: tmp[0] * c, y: tmp[1] * c, trueX: tmp[0], f, rad: m.radiusKm / SHAPES.jupiter.eqRadiusKm });
            if (f & MOON_SHADOW) {
                toFrame(frame, g.shadowS, tmp, 0, k * 3);
                out.shadow[k] = [tmp[0], tmp[1], m.radiusKm / SHAPES.jupiter.eqRadiusKm];
            }
        });
        out.R = R;
        return out;
    }

    function update(snap, id) {
        lastSnap = snap;
        lastId = id;
        const i = BODY_INDEX[id];
        const st = snap && snap.bodies ? snap.bodies[i] : null;
        if (!st || id === 'sun' || !st.poleS || !st.lightS) { el.hidden = true; key = ''; return; }
        el.hidden = false;
        if (id === 'moon') loadMoonTexture();
        discFrame(st.dirS, st.poleS, frame);
        discView(st, frame, view);
        const R = RADIUS[id] ?? 40;
        const moons = id === 'jupiter' ? moonsFor(snap, R) : null;
        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        const q = (x, s) => Math.round(x / s);
        const grsLon = grsLongitudeDeg(snap.tMs);
        const k = [id, q(view.phaseAngleDeg, 0.2), q(view.limbAngleDeg, 0.5), q(view.subLatDeg, 0.2), q(view.cmDeg, id === 'jupiter' || id === 'mars' ? 2 : 10),
            moons ? moons.list.map((o) => `${q(o.x * R, 1)},${q(o.y * R, 1)},${o.f}`).join(';') : '',
            id === 'moon' ? `${moonTexState}${q(snap.libration?.elonDeg ?? 0, 0.2)},${q(snap.libration?.elatDeg ?? 0, 0.2)}` : '',
            id === 'jupiter' ? q(grsLon, 2) : '', dpr].join('|');
        if (k !== key) {
            key = k;
            draw(id, R, moons, dpr, grsLon);
        }
        const text = captionFor(snap, id, st, moons);
        setText(caption, text);
        canvas.setAttribute('aria-label', t('{body} as a small telescope shows it now: {text}', { body: t(BODIES[i].name), text }));
        setText(note, id === 'moon' ? t('Lunar north up · magnified') : id === 'jupiter' || id === 'saturn' || id === 'mars'
            ? t('Planet north up, east left · magnified · markings schematic') : t('Planet north up, east left · magnified'));
    }

    function draw(id, R, moons, dpr, grsLon) {
        if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
        const c = canvas.getContext('2d');
        if (!c) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, canvas.width, canvas.height);
        const cx = (W / 2) * dpr, cy = (id === 'jupiter' ? H / 2 - 8 : H / 2) * dpr;
        const Rd = R * dpr;
        const aa = 1 / Rd;
        const kind = KIND[id];
        const ext = id === 'saturn' ? 2.3 : 1.05;
        const hw = Math.ceil(Rd * ext), hh = Math.ceil(Rd * (id === 'saturn' ? Math.max(1.05, 2.3 * Math.abs(view.pole[2]) + 0.1) : 1.05));
        const x0 = Math.max(0, Math.floor(cx - hw)), x1 = Math.min(canvas.width, Math.ceil(cx + hw));
        const y0 = Math.max(0, Math.floor(cy - hh)), y1 = Math.min(canvas.height, Math.ceil(cy + hh));
        if (x1 <= x0 || y1 <= y0) return;
        const img = c.createImageData(x1 - x0, y1 - y0);
        const d = img.data;
        const oblate = SHAPES[id]?.flattening ?? 0;
        for (let yy = y0; yy < y1; yy++) {
            const y = (cy - (yy + 0.5)) / Rd;
            for (let xx = x0; xx < x1; xx++) {
                const x = (xx + 0.5 - cx) / Rd;
                if (id === 'moon') shadeMoon(x, y, aa, view, px);
                else shadePlanet(x, y, aa, kind, view, oblate, moons, grsLon, px);
                if (!(px[3] > 0.002)) continue;
                const o = ((yy - y0) * (x1 - x0) + (xx - x0)) * 4;
                d[o] = toByte(px[0]); d[o + 1] = toByte(px[1]); d[o + 2] = toByte(px[2]);
                d[o + 3] = Math.round(Math.min(1, px[3]) * 255);
            }
        }
        c.putImageData(img, x0, y0);
        if (!moons) return;
        // Moons: dots at their (log-spaced) positions, initials beneath, E and W at the edges.
        c.font = `${600} ${10 * dpr}px system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'top';
        const placed = [];
        for (const o of compassOrder(moons.list)) {
            const hidden = o.f & (MOON_OCCULTED | MOON_ECLIPSED);
            const mx = cx + o.x * Rd, my = cy - o.y * Rd;
            if (!hidden) {
                c.fillStyle = '#f3ead6';
                c.beginPath();
                c.arc(mx, my, Math.max(o.rad * Rd, 1.6 * dpr), 0, Math.PI * 2);
                c.fill();
            }
            // Initials alternate below/above when two would collide.
            let ty = my + 6 * dpr;
            if (placed.some((p) => Math.abs(p - mx) < 9 * dpr)) ty = my - 17 * dpr;
            placed.push(mx);
            c.fillStyle = hidden ? 'rgba(200, 210, 225, .45)' : 'rgba(225, 232, 244, .85)';
            c.fillText(o.m.short, mx, ty);
        }
        c.fillStyle = 'rgba(200, 210, 225, .6)';
        c.textBaseline = 'middle';
        c.fillText(t('E'), 10 * dpr, cy);
        c.fillText(t('W'), canvas.width - 10 * dpr, cy);
    }

    function captionFor(snap, id, st, moons) {
        if (id === 'moon') {
            const l = snap.libration;
            if (!l) return '';
            const mag = Math.hypot(l.elonDeg, l.elatDeg);
            const dir = librationDirection(l.elonDeg, l.elatDeg);
            const best = bestLimbFeature(l.elonDeg, l.elatDeg);
            let s = dir ? t('Libration {deg}° toward the {dir} limb', { deg: dec(mag, 1), dir: t(dir) }) : t('Libration under half a degree');
            if (best && best.gainDeg >= 2.5) s += ` · ${best.distDeg < 90 ? t('{feature} well placed', { feature: best.name }) : t('{feature} just past the limb', { feature: best.name })}`;
            return `${s}.`;
        }
        if (id === 'jupiter' && moons) {
            const order = compassOrder([...moons.list.filter((o) => !(o.f & (MOON_OCCULTED | MOON_ECLIPSED))), { m: { name: '●' }, x: 0 }]);
            const bits = [order.map((o) => o.m.name).join(' · ')];
            for (const o of moons.list) {
                const v = { moon: o.m.name };
                if (o.f & MOON_OCCULTED) bits.push(t('{moon} behind Jupiter', v));
                else if (o.f & MOON_ECLIPSED) bits.push(t('{moon} in Jupiter’s shadow', v));
                else if (o.f & MOON_TRANSIT) bits.push(t('{moon} crossing the disc', v));
                if (o.f & MOON_SHADOW) bits.push(t('{moon}’s shadow on Jupiter', v));
            }
            return t('East to west: {list}.', { list: bits[0] }) + (bits.length > 1 ? ` ${bits.slice(1).join('; ')}.` : '');
        }
        if (id === 'saturn') {
            const B = -st.ringTiltDeg;
            const v = { deg: dec(Math.abs(B), 1) };
            let s = Math.abs(B) < 0.05 ? t('Rings open {deg}° (edge-on)', v) : B > 0 ? t('Rings open {deg}° (north face)', v) : t('Rings open {deg}° (south face)', v);
            const e = saturnEdgeOn(snap.tMs);
            if (e) {
                const a = monthYear(e.firstMs), b = monthYear(e.lastMs);
                s += ` · ${e.count > 1 && a !== b ? t('edge-on from {from} to {to}', { from: a, to: b }) : t('edge-on in {when}', { when: a })}`;
            }
            return `${s}.`;
        }
        const pct = Math.round((st.phaseFrac ?? 1) * 100);
        if (id === 'mars') {
            const cmW = ((-view.cmDeg % 360) + 360) % 360;
            return t('{pct}% lit · central meridian {deg}° W.', { pct, deg: Math.round(cmW) });
        }
        if (id === 'uranus' || id === 'neptune') {
            const tip = view.subLatDeg, v = { deg: Math.abs(tip).toFixed(0) };
            return tip >= 0 ? t('North pole tipped {deg}° toward us.', v) : t('South pole tipped {deg}° toward us.', v);
        }
        const shape = pct < 3 ? N_('a hair-thin crescent') : pct < 45 ? N_('a crescent') : pct < 55 ? N_('half lit') : pct < 97 ? N_('gibbous') : N_('nearly full');
        return t('{pct}% lit, {shape} · phase angle {deg}°.', { pct, shape: t(shape), deg: Math.round(view.phaseAngleDeg) });
    }

    return {
        el,
        update,
        get key() { return key; },
        destroy() { moonTexWaiters.delete(redraw); },
    };
}
