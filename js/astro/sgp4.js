/**
 * Near-Earth SGP4 (pure; no three.js, no DOM): the NORAD propagator for two-line element sets, as
 * revised by Vallado, Crawford, Hujsak and Kelso, "Revisiting Spacetrack Report #3" (AIAA 2006-6753,
 * rev. 3), with WGS-72 constants — the ones the element sets are fitted with.
 *
 * Only the near-Earth branch is implemented: an orbit with a period of 225 minutes or more needs
 * SDP4's lunar–solar terms, and {@link sgp4init} rejects it (`error` 'deep-space'). Everything the
 * app tracks (the ISS, Tiangong, Hubble, bright rocket bodies) is in low Earth orbit. The code
 * follows Vallado's sgp4init/sgp4 line for line (including the "sgp4fix" corrections), so the
 * published verification vectors (test/astro.sgp4.test.mjs) match to well under a metre.
 *
 * Output is the TEME frame (true equator, mean equinox of date), km and km/s. {@link temeToEf}
 * turns it Earth-fixed with Greenwich mean sidereal time (IAU 1982, {@link gstime}), as SGP4 users
 * do; polar motion (≈ 10 m) is ignored.
 *
 * No per-call allocation: {@link sgp4} writes into the caller's arrays.
 *
 * @module astro/sgp4
 */

const TWO_PI = 2 * Math.PI;
const DEG2RAD = Math.PI / 180;
const X2O3 = 2 / 3;

/** WGS-72 gravity model (Spacetrack Report #3, as SGP4 element sets assume). */
export const WGS72 = Object.freeze((() => {
    const mu = 398600.8;            // km³/s²
    const radiusearthkm = 6378.135; // km
    const xke = 60 / Math.sqrt(radiusearthkm ** 3 / mu);
    const j2 = 0.001082616, j3 = -0.00000253881, j4 = -0.00000165597;
    return { mu, radiusearthkm, xke, tumin: 1 / xke, j2, j3, j4, j3oj2: j3 / j2 };
})());

/** Periods at or above this many minutes need the deep-space branch (SDP4). */
export const DEEP_SPACE_MIN = 225;

/**
 * @typedef {object} Satrec SGP4 state for one element set (sgp4init's output; treat as opaque).
 * @property {number} satnum NORAD catalogue number
 * @property {number} epochMs element epoch, UTC ms
 * @property {string|null} error null, or why propagation failed ('deep-space', 'eccentricity',
 *   'mean-motion', 'semi-latus', 'decayed')
 * @property {number} noKozai mean motion, rad/min (as given)
 * @property {number} periodMin orbital period, minutes
 */

/**
 * TLE checksum: the sum of the digits of the first 68 columns, minus signs counting 1, modulo 10.
 * @param {string} line
 * @returns {number}
 */
export function tleChecksum(line) {
    let sum = 0;
    for (let i = 0; i < 68 && i < line.length; i++) {
        const c = line.charCodeAt(i);
        if (c >= 48 && c <= 57) sum += c - 48;
        else if (c === 45) sum += 1;
    }
    return sum % 10;
}

/** " 28098-4" / "-11606-4" / " 00000+0" → 0.28098e-4 etc. (TLE's assumed-decimal exponent fields). */
function expField(s) {
    const t = s.trim();
    if (!t) return 0;
    const m = /^([+-]?)(\d+)([+-]\d+)$/.exec(t.replace(/\s+/g, ''));
    if (!m) return Number.parseFloat(t) || 0;
    return Number(`${m[1]}0.${m[2]}e${m[3]}`);
}

/**
 * Parses a two-line element set (columns per Spacetrack Report #3; checksums are verified unless
 * `opts.checksum` is false).
 * @param {string} line1
 * @param {string} line2
 * @param {{checksum?:boolean}} [opts]
 * @returns {{satnum:number, intlDes:string, epochMs:number, ndot:number, nddot:number, bstar:number,
 *   inclDeg:number, raanDeg:number, ecc:number, argpDeg:number, maDeg:number, revPerDay:number, revNum:number}}
 * @throws {TypeError} on a malformed line or a checksum mismatch
 */
export function parseTle(line1, line2, opts = {}) {
    const l1 = String(line1 ?? '').replace(/\s+$/, '');
    const l2 = String(line2 ?? '').replace(/\s+$/, '');
    if (l1[0] !== '1' || l2[0] !== '2' || l1.length < 64 || l2.length < 63) throw new TypeError('TLE: not a two-line element set');
    if (opts.checksum !== false) {
        for (const l of [l1, l2]) {
            if (l.length >= 69 && Number(l[68]) !== tleChecksum(l)) throw new TypeError(`TLE: checksum mismatch in line ${l[0]}`);
        }
    }
    const satnum = Number.parseInt(l1.slice(2, 7), 10);
    if (Number.parseInt(l2.slice(2, 7), 10) !== satnum) throw new TypeError('TLE: the two lines name different satellites');
    const yy = Number.parseInt(l1.slice(18, 20), 10);
    const doy = Number.parseFloat(l1.slice(20, 32));
    const year = yy < 57 ? 2000 + yy : 1900 + yy;
    const epochMs = Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
    const out = {
        satnum, intlDes: l1.slice(9, 17).trim(), epochMs,
        ndot: Number.parseFloat(l1.slice(33, 43)), nddot: expField(l1.slice(44, 52)), bstar: expField(l1.slice(53, 61)),
        inclDeg: Number.parseFloat(l2.slice(8, 16)), raanDeg: Number.parseFloat(l2.slice(17, 25)),
        ecc: Number(`0.${l2.slice(26, 33).trim()}`), argpDeg: Number.parseFloat(l2.slice(34, 42)),
        maDeg: Number.parseFloat(l2.slice(43, 51)), revPerDay: Number.parseFloat(l2.slice(52, 63)),
        revNum: Number.parseInt(l2.slice(63, 68), 10) || 0,
    };
    for (const k of ['epochMs', 'inclDeg', 'raanDeg', 'ecc', 'argpDeg', 'maDeg', 'revPerDay', 'bstar']) {
        if (!Number.isFinite(out[k])) throw new TypeError(`TLE: bad ${k}`);
    }
    return out;
}

/**
 * Initialises SGP4 for one element set (Vallado's sgp4init, near-Earth branch). Never throws: a
 * deep-space orbit or degenerate elements come back with `error` set.
 * @param {ReturnType<typeof parseTle>} el
 * @returns {Satrec}
 */
export function sgp4init(el) {
    const { radiusearthkm, xke, j2, j3oj2, j4 } = WGS72;
    const ecco = el.ecc, inclo = el.inclDeg * DEG2RAD, nodeo = el.raanDeg * DEG2RAD;
    const argpo = el.argpDeg * DEG2RAD, mo = el.maDeg * DEG2RAD, bstar = el.bstar;
    const noKozai = el.revPerDay * TWO_PI / 1440;
    const s = {
        satnum: el.satnum, epochMs: el.epochMs, error: null, noKozai, periodMin: NaN,
        ecco, inclo, nodeo, argpo, mo, bstar, noUnkozai: 0, isimp: 0,
        aycof: 0, con41: 0, cc1: 0, cc4: 0, cc5: 0, d2: 0, d3: 0, d4: 0, delmo: 0, eta: 0, argpdot: 0, omgcof: 0,
        sinmao: 0, t2cof: 0, t3cof: 0, t4cof: 0, t5cof: 0, x1mth2: 0, x7thm1: 0, mdot: 0, nodedot: 0, xlcof: 0,
        xmcof: 0, nodecf: 0,
    };
    // initl: un-Kozai the mean motion.
    const eccsq = ecco * ecco;
    const omeosq = 1 - eccsq;
    const rteosq = Math.sqrt(omeosq);
    const cosio = Math.cos(inclo);
    const cosio2 = cosio * cosio;
    const ak = Math.pow(xke / noKozai, X2O3);
    const d1 = 0.75 * j2 * (3 * cosio2 - 1) / (rteosq * omeosq);
    let del = d1 / (ak * ak);
    const adel = ak * (1 - del * del - del * (1 / 3 + 134 * del * del / 81));
    del = d1 / (adel * adel);
    const noUnkozai = noKozai / (1 + del);
    s.noUnkozai = noUnkozai;
    s.periodMin = TWO_PI / noUnkozai;
    if (!(noUnkozai > 0) || !(ecco >= 0 && ecco < 1)) { s.error = 'mean-motion'; return s; }
    if (s.periodMin >= DEEP_SPACE_MIN) { s.error = 'deep-space'; return s; }
    const ao = Math.pow(xke / noUnkozai, X2O3);
    const sinio = Math.sin(inclo);
    const po = ao * omeosq;
    const con42 = 1 - 5 * cosio2;
    s.con41 = -con42 - cosio2 - cosio2;
    const posq = po * po;
    const rp = ao * (1 - ecco);

    // sgp4init proper.
    const ss = 78 / radiusearthkm + 1;
    const qzms2ttemp = (120 - 78) / radiusearthkm;
    const qzms2t = qzms2ttemp * qzms2ttemp * qzms2ttemp * qzms2ttemp;
    s.isimp = rp < 220 / radiusearthkm + 1 ? 1 : 0;
    let sfour = ss;
    let qzms24 = qzms2t;
    const perige = (rp - 1) * radiusearthkm;
    // Perigees below 156 km: s and qoms2t are altered.
    if (perige < 156) {
        sfour = perige < 98 ? 20 : perige - 78;
        const q = (120 - sfour) / radiusearthkm;
        qzms24 = q * q * q * q;
        sfour = sfour / radiusearthkm + 1;
    }
    const pinvsq = 1 / posq;
    const tsi = 1 / (ao - sfour);
    s.eta = ao * ecco * tsi;
    const etasq = s.eta * s.eta;
    const eeta = ecco * s.eta;
    const psisq = Math.abs(1 - etasq);
    const coef = qzms24 * Math.pow(tsi, 4);
    const coef1 = coef / Math.pow(psisq, 3.5);
    const cc2 = coef1 * noUnkozai * (ao * (1 + 1.5 * etasq + eeta * (4 + etasq))
        + 0.375 * j2 * tsi / psisq * s.con41 * (8 + 3 * etasq * (8 + etasq)));
    s.cc1 = bstar * cc2;
    let cc3 = 0;
    if (ecco > 1e-4) cc3 = -2 * coef * tsi * j3oj2 * noUnkozai * sinio / ecco;
    s.x1mth2 = 1 - cosio2;
    s.cc4 = 2 * noUnkozai * coef1 * ao * omeosq * (s.eta * (2 + 0.5 * etasq) + ecco * (0.5 + 2 * etasq)
        - j2 * tsi / (ao * psisq) * (-3 * s.con41 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta))
        + 0.75 * s.x1mth2 * (2 * etasq - eeta * (1 + etasq)) * Math.cos(2 * argpo)));
    s.cc5 = 2 * coef1 * ao * omeosq * (1 + 2.75 * (etasq + eeta) + eeta * etasq);
    const cosio4 = cosio2 * cosio2;
    const temp1 = 1.5 * j2 * pinvsq * noUnkozai;
    const temp2 = 0.5 * temp1 * j2 * pinvsq;
    const temp3 = -0.46875 * j4 * pinvsq * pinvsq * noUnkozai;
    s.mdot = noUnkozai + 0.5 * temp1 * rteosq * s.con41 + 0.0625 * temp2 * rteosq * (13 - 78 * cosio2 + 137 * cosio4);
    s.argpdot = -0.5 * temp1 * con42 + 0.0625 * temp2 * (7 - 114 * cosio2 + 395 * cosio4)
        + temp3 * (3 - 36 * cosio2 + 49 * cosio4);
    const xhdot1 = -temp1 * cosio;
    s.nodedot = xhdot1 + (0.5 * temp2 * (4 - 19 * cosio2) + 2 * temp3 * (3 - 7 * cosio2)) * cosio;
    s.omgcof = bstar * cc3 * Math.cos(argpo);
    s.xmcof = ecco > 1e-4 ? -X2O3 * coef * bstar / eeta : 0;
    s.nodecf = 3.5 * omeosq * xhdot1 * s.cc1;
    s.t2cof = 1.5 * s.cc1;
    // sgp4fix: no divide by zero at 180° inclination.
    s.xlcof = Math.abs(cosio + 1) > 1.5e-12
        ? -0.25 * j3oj2 * sinio * (3 + 5 * cosio) / (1 + cosio)
        : -0.25 * j3oj2 * sinio * (3 + 5 * cosio) / 1.5e-12;
    s.aycof = -0.5 * j3oj2 * sinio;
    const dm = 1 + s.eta * Math.cos(mo);
    s.delmo = dm * dm * dm;
    s.sinmao = Math.sin(mo);
    s.x7thm1 = 7 * cosio2 - 1;
    if (s.isimp !== 1) {
        const cc1sq = s.cc1 * s.cc1;
        s.d2 = 4 * ao * tsi * cc1sq;
        const temp = s.d2 * tsi * s.cc1 / 3;
        s.d3 = (17 * ao + sfour) * temp;
        s.d4 = 0.5 * temp * ao * tsi * (221 * ao + 31 * sfour) * s.cc1;
        s.t3cof = s.d2 + 2 * cc1sq;
        s.t4cof = 0.25 * (3 * s.d3 + s.cc1 * (12 * s.d2 + 10 * cc1sq));
        s.t5cof = 0.2 * (3 * s.d4 + 12 * s.cc1 * s.d3 + 6 * s.d2 * s.d2 + 15 * cc1sq * (2 * s.d2 + cc1sq));
    }
    return s;
}

/** fmod with C semantics (the sign of the dividend), as Vallado's code relies on. */
function fmod(a, b) {
    return a % b;
}

/**
 * Propagates `tsince` minutes from the element epoch (Vallado's sgp4, near-Earth branch).
 * @param {Satrec} s from {@link sgp4init}
 * @param {number} tsince minutes since epoch (may be negative)
 * @param {Float64Array|number[]} r out: TEME position, km
 * @param {Float64Array|number[]} [v] out: TEME velocity, km/s
 * @returns {string|null} null on success, else the reason ('decayed', …); `r`/`v` are then unreliable
 */
export function sgp4(s, tsince, r, v) {
    if (s.error) return s.error;
    const { radiusearthkm, xke, j2 } = WGS72;
    const vkmpersec = radiusearthkm * xke / 60;
    const t = tsince;
    // Secular gravity and atmospheric drag.
    const xmdf = s.mo + s.mdot * t;
    const argpdf = s.argpo + s.argpdot * t;
    const nodedf = s.nodeo + s.nodedot * t;
    let argpm = argpdf;
    let mm = xmdf;
    const t2 = t * t;
    let nodem = nodedf + s.nodecf * t2;
    let tempa = 1 - s.cc1 * t;
    let tempe = s.bstar * s.cc4 * t;
    let templ = s.t2cof * t2;
    if (s.isimp !== 1) {
        const delomg = s.omgcof * t;
        const dmt = 1 + s.eta * Math.cos(xmdf);
        const delm = s.xmcof * (dmt * dmt * dmt - s.delmo);
        const temp = delomg + delm;
        mm = xmdf + temp;
        argpm = argpdf - temp;
        const t3 = t2 * t;
        const t4 = t3 * t;
        tempa = tempa - s.d2 * t2 - s.d3 * t3 - s.d4 * t4;
        tempe += s.bstar * s.cc5 * (Math.sin(mm) - s.sinmao);
        templ += s.t3cof * t3 + t4 * (s.t4cof + t * s.t5cof);
    }
    let nm = s.noUnkozai;
    let em = s.ecco;
    const inclm = s.inclo;
    if (!(nm > 0)) return 'mean-motion';
    const am = Math.pow(xke / nm, X2O3) * tempa * tempa;
    nm = xke / Math.pow(am, 1.5);
    em -= tempe;
    if (!(em < 1) || em < -0.001) return 'eccentricity';
    if (em < 1e-6) em = 1e-6;
    mm += s.noUnkozai * templ;
    let xlm = mm + argpm + nodem;
    nodem = fmod(nodem, TWO_PI);
    argpm = fmod(argpm, TWO_PI);
    xlm = fmod(xlm, TWO_PI);
    mm = fmod(xlm - argpm - nodem, TWO_PI);

    const sinip = Math.sin(inclm), cosip = Math.cos(inclm);
    // Long-period periodics.
    const axnl = em * Math.cos(argpm);
    let temp = 1 / (am * (1 - em * em));
    const aynl = em * Math.sin(argpm) + temp * s.aycof;
    const xl = mm + argpm + nodem + temp * s.xlcof * axnl;

    // Kepler's equation.
    const u = fmod(xl - nodem, TWO_PI);
    let eo1 = u;
    let tem5 = 9999.9;
    let sineo1 = 0, coseo1 = 0;
    for (let ktr = 1; Math.abs(tem5) >= 1e-12 && ktr <= 10; ktr++) {
        sineo1 = Math.sin(eo1);
        coseo1 = Math.cos(eo1);
        tem5 = 1 - coseo1 * axnl - sineo1 * aynl;
        tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
        if (Math.abs(tem5) >= 0.95) tem5 = tem5 > 0 ? 0.95 : -0.95;
        eo1 += tem5;
    }

    // Short-period preliminaries.
    const ecose = axnl * coseo1 + aynl * sineo1;
    const esine = axnl * sineo1 - aynl * coseo1;
    const el2 = axnl * axnl + aynl * aynl;
    const pl = am * (1 - el2);
    if (pl < 0) return 'semi-latus';
    const rl = am * (1 - ecose);
    const rdotl = Math.sqrt(am) * esine / rl;
    const rvdotl = Math.sqrt(pl) / rl;
    const betal = Math.sqrt(1 - el2);
    temp = esine / (1 + betal);
    const sinu = am / rl * (sineo1 - aynl - axnl * temp);
    const cosu = am / rl * (coseo1 - axnl + aynl * temp);
    let su = Math.atan2(sinu, cosu);
    const sin2u = (cosu + cosu) * sinu;
    const cos2u = 1 - 2 * sinu * sinu;
    temp = 1 / pl;
    const temp1 = 0.5 * j2 * temp;
    const temp2 = temp1 * temp;

    // Short-period periodics.
    const mrt = rl * (1 - 1.5 * temp2 * betal * s.con41) + 0.5 * temp1 * s.x1mth2 * cos2u;
    su -= 0.25 * temp2 * s.x7thm1 * sin2u;
    const xnode = nodem + 1.5 * temp2 * cosip * sin2u;
    const xinc = inclm + 1.5 * temp2 * cosip * sinip * cos2u;
    const mvt = rdotl - nm * temp1 * s.x1mth2 * sin2u / xke;
    const rvdot = rvdotl + nm * temp1 * (s.x1mth2 * cos2u + 1.5 * s.con41) / xke;

    // Orientation vectors.
    const sinsu = Math.sin(su), cossu = Math.cos(su);
    const snod = Math.sin(xnode), cnod = Math.cos(xnode);
    const sini = Math.sin(xinc), cosi = Math.cos(xinc);
    const xmx = -snod * cosi;
    const xmy = cnod * cosi;
    const ux = xmx * sinsu + cnod * cossu;
    const uy = xmy * sinsu + snod * cossu;
    const uz = sini * sinsu;
    r[0] = mrt * ux * radiusearthkm;
    r[1] = mrt * uy * radiusearthkm;
    r[2] = mrt * uz * radiusearthkm;
    if (v) {
        const vx = xmx * cossu - cnod * sinsu;
        const vy = xmy * cossu - snod * sinsu;
        const vz = sini * cossu;
        v[0] = (mvt * ux + rvdot * vx) * vkmpersec;
        v[1] = (mvt * uy + rvdot * vy) * vkmpersec;
        v[2] = (mvt * uz + rvdot * vz) * vkmpersec;
    }
    // sgp4fix: a satellite below the Earth's surface has decayed.
    return mrt < 1 ? 'decayed' : null;
}

/**
 * Greenwich mean sidereal time (IAU 1982, Vallado's gstime), radians in [0, 2π).
 * @param {number} jdut1 Julian date, UT1 (UTC is used: |UT1 − UTC| < 0.9 s, ≤ 0.4 km at the equator)
 * @returns {number}
 */
export function gstime(jdut1) {
    const tut1 = (jdut1 - 2451545.0) / 36525;
    let g = -6.2e-6 * tut1 * tut1 * tut1 + 0.093104 * tut1 * tut1 + (876600 * 3600 + 8640184.812866) * tut1 + 67310.54841;
    g = fmod(g * DEG2RAD / 240, TWO_PI);
    return g < 0 ? g + TWO_PI : g;
}

/**
 * TEME → Earth-fixed (pseudo-Earth-fixed: GMST rotation, no polar motion). In place is fine.
 * @param {ArrayLike<number>} teme
 * @param {number} gmst radians ({@link gstime})
 * @param {Float64Array|number[]} out
 * @returns {Float64Array|number[]}
 */
export function temeToEf(teme, gmst, out) {
    const c = Math.cos(gmst), s = Math.sin(gmst);
    const x = teme[0], y = teme[1];
    out[0] = c * x + s * y;
    out[1] = -s * x + c * y;
    out[2] = teme[2];
    return out;
}

/** Julian date (UTC) of a Unix time in ms. */
export function jdOfMs(ms) {
    return ms / 86400000 + 2440587.5;
}
