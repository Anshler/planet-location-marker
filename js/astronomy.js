import * as THREE from 'three';
import { DEG, J2000 } from './constants.js';
import { EARTH_ORBITAL } from './planets.js';

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

export function orbitalElements(orbital, JD) {
    const T = (JD - J2000) / 36525;
    return {
        a:      orbital.a[0]     + orbital.a[1]     * T,
        e:      orbital.e[0]     + orbital.e[1]     * T,
        I:     (orbital.I[0]     + orbital.I[1]     * T) * DEG,
        L:     (orbital.L[0]     + orbital.L[1]     * T) * DEG,
        w_bar: (orbital.w_bar[0] + orbital.w_bar[1] * T) * DEG,
        Omega: (orbital.Omega[0] + orbital.Omega[1] * T) * DEG,
    };
}

export function heliocentricPosition(orbital, JD) {
    const el = orbitalElements(orbital, JD);
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

export function heliocentricEarthPosition(JD) {
    return heliocentricPosition(EARTH_ORBITAL, JD);
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
