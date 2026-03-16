import * as THREE from 'three';
import { DEG, J2000, EARTH_RADIUS_AU } from './constants.js';

export function normalizeAngleRad(x) {
    x %= 2 * Math.PI;
    return x < 0 ? x + 2 * Math.PI : x;
}

export function solveKepler(M, e) {
    M = normalizeAngleRad(M);
    let E = M;
    for (let i = 0; i < 10; i++) {
        E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }
    return E;
}

export function orbitalElements(body, JD) {
    const T = (JD - J2000) / 36525;
    if (body === "earth") return {
        a: 1.00000261 + 0.00000562 * T,
        e: 0.01671123 - 0.00004392 * T,
        I: (-0.00001531 - 0.01294668 * T) * DEG,
        L: (100.46457166 + 35999.37244981 * T) * DEG,
        w_bar: (102.93768193 + 0.32327364 * T) * DEG,
        Omega: 0
    };
    if (body === "mars") return {
        a: 1.52371034 + 0.00001847 * T,
        e: 0.09339410 + 0.00007882 * T,
        I: (1.84969142 - 0.00813131 * T) * DEG,
        L: (-4.55343205 + 19140.30268499 * T) * DEG,
        w_bar: (-23.94362959 + 0.44441088 * T) * DEG,
        Omega: (49.55953891 - 0.29257343 * T) * DEG
    };
}

export function heliocentricPosition(body, JD) {
    const el = orbitalElements(body, JD);
    const M = normalizeAngleRad(el.L - el.w_bar);
    const E = solveKepler(M, el.e);
    const xv = el.a * (Math.cos(E) - el.e);
    const yv = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
    const v = Math.atan2(yv, xv);
    const r = Math.sqrt(xv * xv + yv * yv);
    const w = el.w_bar - el.Omega;
    const xh = r * (Math.cos(el.Omega) * Math.cos(v + w) -
        Math.sin(el.Omega) * Math.sin(v + w) * Math.cos(el.I));
    const yh = r * (Math.sin(el.Omega) * Math.cos(v + w) +
        Math.cos(el.Omega) * Math.sin(v + w) * Math.cos(el.I));
    const zh = r * (Math.sin(v + w) * Math.sin(el.I));
    return new THREE.Vector3(xh, yh, zh);
}

export function julianDate(date) {
    return date.getTime() / 86400000 + 2440587.5;
}

export function gmst(date) {
    const JD = julianDate(date);
    const T = (JD - J2000) / 36525;
    let theta = 280.46061837 +
        360.98564736629 * (JD - J2000) +
        0.000387933 * T * T -
        T * T * T / 38710000;
    theta = ((theta % 360) + 360) % 360;
    return theta * DEG;
}

export function latLonToVector3(lat, lon) {
    const phi = (90 - lat) * DEG;
    const theta = (lon + 180) * DEG;
    return new THREE.Vector3(
        -Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta)
    );
}
