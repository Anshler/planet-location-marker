/**
 * GLSL for the night sky's own brightness (js/astro/skyglow.js, the reference implementation; its
 * uniforms come from snap.skyglow through js/render/skyglow.js): the natural sky with van Rhijn
 * airglow, the Krisciunas & Schaefer (1991) moonlit sky and the light dome of nearby cities, in
 * natural-sky units (1 = a dark site's moonless zenith, 22.0 mag/arcsec²).
 *
 * The sky dome (ground.glsl.js TWILIGHT_CHUNK), the ground, the stars (limit per direction) and
 * the Milky Way (contrast per direction) include SKYGLOW_CHUNK. Only skyglowSky/skyglowGround/
 * skyglowNight are display mappings (illustrative); the rest is the physical model.
 */

/** @type {string} */
export const SKYGLOW_CHUNK = /* glsl */`
uniform vec4 uSgMoon;     // xyz: the Moon's direction; w: I*·10^(−0.4·k·X(Zm))·lit / B_nat (0 when down)
uniform float uSgK;       // V extinction, mag per airmass
uniform float uSgLpZen;   // artificial light at the zenith
uniform float uSgLp[16];  // … at the horizon, bin k toward k·22.5° east of north
uniform vec3 uSgUp;
uniform vec3 uSgNorth;
uniform vec3 uSgEast;
uniform float uSgDome;    // night factor of the dome terms (0 by day)
uniform float uSgDark;    // dark-sky gate: 1 under Bortle 1–3 skies without the Moon
// KS91 optical path X(Z) = (1 − 0.96·sin²Z)^−½ = (0.04 + 0.96·cos²Z)^−½.
float sgAirmass(float cz) {
    float c = clamp(cz, 0.0, 1.0);
    return inversesqrt(max(0.04 + 0.96 * c * c, 0.04));
}
// Natural sky, X·10^(−0.4·k·(X − 1)): 1 at the zenith, ≈ 2.7 at the horizon.
float sgNatural(float cz) {
    float X = sgAirmass(cz);
    return X * exp(-0.921034 * uSgK * (X - 1.0));
}
// Moonlit sky (KS91 eq. 15): its Rayleigh (x) and Mie (y) parts.
vec2 sgMoon(vec3 d, float cz) {
    if (uSgMoon.w <= 0.0) return vec2(0.0);
    float cr = clamp(dot(d, uSgMoon.xyz), -1.0, 1.0);
    float rho = max(degrees(acos(clamp(cr, -1.0, 1.0))), 10.0);
    float k = uSgMoon.w * (1.0 - exp(-0.921034 * uSgK * sgAirmass(cz)));
    return k * vec2(229086.765 * (1.06 + cr * cr), exp(2.302585 * (6.15 - rho / 40.0)));
}
// Light pollution: the zenith value rising to the azimuth bins' horizon value (skyglow.js lpAt).
float sgLp(vec3 d, float cz) {
    vec3 hz = d - uSgUp * cz;
    float e = dot(hz, uSgEast), n = dot(hz, uSgNorth);
    float az = (e == 0.0 && n == 0.0) ? 0.0 : atan(e, n);   // atan(0, 0) is undefined
    float x = fract(az / 6.2831853 + 1.0) * 16.0;
    int i = min(int(x), 15);
    float hzn = mix(uSgLp[i], uSgLp[(i + 1) % 16], clamp(x - float(i), 0.0, 1.0));
    float w = (exp(-asin(clamp(cz, 0.0, 1.0)) / 0.5934119) - 0.0708593) / 0.9291407;   // 1 → 0, horizon → zenith
    return uSgLpZen + (hzn - uSgLpZen) * w;
}
// The whole sky toward d (natural + Moon + cities), and its excess over the natural sky in magnitudes.
float sgSky(vec3 d) {
    float cz = clamp(dot(d, uSgUp), 0.0, 1.0);
    vec2 m = sgMoon(d, cz);
    return sgNatural(cz) + m.x + m.y + sgLp(d, cz);
}
float sgExcessMag(vec3 d) {
    float cz = clamp(dot(d, uSgUp), 0.0, 1.0);
    vec2 m = sgMoon(d, cz);
    return 1.0857362 * log(max(1.0 + (m.x + m.y + sgLp(d, cz)) / sgNatural(cz), 1.0));
}
// Naked-eye limit for a sky of R natural units (photometry.limitingMag of its SQM reading).
float sgLimitMag(float R) {
    float sqm = 22.0 - 1.0857362 * log(max(R, 1e-6));
    return 7.93 - 2.1714724 * log(exp(2.302585 * (4.316 - sqm / 5.0)) + 1.0);
}
// Display: natural-sky units compressed as R^0.6 (a city's R ≈ 100 or a full Moon's ≈ 40 reads as a
// dim orange or deep blue sky; ACES's toe swallows R ≲ 5). Illustrative.
vec3 sgDisplay(vec3 c, float sum) {
    return c * (0.0029 * uSgDome * exp(-0.4 * log(max(sum, 1e-4))));
}
// Sky view dome: blue Rayleigh moonlight, a white Mie aureole round the Moon, an orange
// (sodium/LED) light dome toward the cities.
vec3 skyglowSky(vec3 d) {
    if (uSgDome <= 0.0) return vec3(0.0);
    float cz = clamp(dot(d, uSgUp), 0.0, 1.0);
    vec2 m = sgMoon(d, cz);
    float lp = sgLp(d, cz);
    float sum = m.x + m.y + lp;
    if (sum <= 1e-4) return vec3(0.0);
    return sgDisplay(m.x * vec3(0.62, 1.0, 1.75) + m.y * vec3(1.0, 0.98, 0.94) + lp * vec3(1.32, 1.0, 0.68), sum);
}
// The land under that sky: lit by the Moon (neutral) and the city lights (orange).
vec3 skyglowGround() {
    if (uSgDome <= 0.0) return vec3(0.0);
    vec2 m = sgMoon(uSgUp, 1.0);
    float mo = 0.45 * (m.x + m.y), lp = 0.35 * uSgLpZen;
    if (mo + lp <= 1e-4) return vec3(0.0);
    return sgDisplay(mo * vec3(0.92, 0.97, 1.08) + lp * vec3(1.32, 1.0, 0.68), mo + lp);
}
// Natural night sky: a faint floor plus airglow brightening toward the horizon (van Rhijn). Under a
// dark sky (uSgDark) the band leans to the green of the 557.7 nm [O I] line; subtly, since
// night vision is nearly colourless.
vec3 skyglowNight(float hp) {
    vec3 band = mix(vec3(0.0105, 0.0140, 0.0180), vec3(0.0098, 0.0158, 0.0138), uSgDark);
    return vec3(0.0010, 0.0014, 0.0026) + band * exp(-hp / 0.11);
}
`;
