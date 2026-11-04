/**
 * GLSL for the Sun, Moon, planet glyphs, selection reticle and lens flare (G5, SPEC E.5).
 * Every fragment shader ends with the tonemapping/colorspace includes (SPEC R6).
 */
import { INFINITY_VERT_CHUNK, REFRACT_CHUNK } from './sky.glsl.js';
import { FINITE_CHUNK } from './common.glsl.js';

const TONE = /* glsl */`
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
`;

/**
 * Billboard at infinity, sized in angle: the quad spans ±uTanR in tangent space around uDir, so
 * it scales with the field of view like a real disc. Used for the Sun and the Moon's aureole.
 */
export const DISC_VERT = /* glsl */`
uniform vec3 uDir;
uniform float uTanR;
varying vec2 vUv;
${INFINITY_VERT_CHUNK}
void main() {
    vec4 c = infinityClip(normalize(uDir));
    vUv = position.xy;
    c.xy += position.xy * uTanR * vec2(projectionMatrix[0][0], projectionMatrix[1][1]) * c.w;
    gl_Position = c;
}
`;

/**
 * Totality in sky view (the Sun's material only, under #define SUN_ECLIPSE; the Moon aureole shares
 * DISC_FRAG without it). Every term sits behind a uniform branch, so outside eclipses the material
 * neither recompiles nor pays for it. The Moon's depth pre-pass hides whatever lies behind its disc,
 * so the chromosphere and prominences show only where its limb uncovers them, near second and third
 * contact (bodies.js; js/astro/totality.js has the pure parts).
 * - Thin crescent (uThin): the sub-pixel sliver between the limbs as a one-pixel ring just outside
 *   the Sun's limb carrying the sliver's true width w(θ) = ρ☉ − far Moon limb (flux-conserving),
 *   instead of the disc's anti-aliasing fringe, which lit ±45° of limb at FOV 5°.
 * - Corona (uTotality): Baumbach's K+F radial law I(ρ) = 0.0532ρ^-2.5 + 1.425ρ^-7 + 2.565ρ^-17
 *   mapped to display as 1.05·I^0.743 (ρ 1.08 → 1.5, ρ 4 → 0.01; the 1250:1 range compressed to
 *   ~150:1), Ludendorff flattening along the solar equator, four helmet streamers, polar plumes and
 *   fibrous noise in (θ, log ρ), oriented by the Sun's rotation pole on screen (uPoleUv). The outer
 *   corona is stretched to a minimum size (uCorStretch). Illustrative: seeded by date, not predicted.
 * - Chromosphere (uChromo, the flash at the contacts; ≥ 2.5 px) and four prominences, H-alpha pink
 *   laid over the corona rather than added to it, which ACES turned white.
 */
const ECLIPSE_CHUNK = /* glsl */`
#ifdef SUN_ECLIPSE
${FINITE_CHUNK}
uniform float uSunR;        // true angular radius (rad)
uniform float uTotality;    // corona, prominences: 0 skips the branch
uniform float uThin;        // thin-crescent ring: 0 skips it
uniform float uChromo;      // chromosphere flash
uniform vec3 uMoon;         // Moon centre offset from the Sun (xy, rad, quad axes) and its radius (z)
uniform vec3 uLimbColor;    // the limb's HDR colour for the thin crescent
uniform vec3 uCoronaColor;  // corona tint (extinction × display)
uniform float uCorStretch;  // >= 1
uniform vec2 uPoleUv;       // solar north on screen (unit, quad axes)
uniform float uCorFlat;     // Ludendorff flattening
uniform float uCorSeed;
uniform vec4 uStrPA;        // helmet streamers: position angle from solar north (rad)
uniform vec4 uStrW;         //   base half-width (rad)
uniform vec4 uStrG;         //   gain
uniform vec4 uPromPA;       // prominences: position angle (rad)
uniform vec4 uPromH;        //   height (solar radii)
uniform vec4 uPromW;        //   half-width (rad)
float eclHash(float n) { return fract(sin(n) * 43758.5453123); }
// Value noise, periodic in x with period p (cells), seeded by date.
float eclNoise(vec2 x, float p) {
    vec2 i = floor(x);
    vec2 f = x - i;
    vec2 u = f * f * (3.0 - 2.0 * f);
    float i0 = mod(i.x, p), i1 = mod(i.x + 1.0, p);
    float s = uCorSeed * 61.0 + i.y * 157.0;
    float a = eclHash(i0 + s), b = eclHash(i1 + s);
    float c = eclHash(i0 + s + 157.0), d = eclHash(i1 + s + 157.0);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Wraps angles to [-pi, pi).
vec4 eclWrap(vec4 a) { return a - 6.2831853 * floor((a + 3.1415927) / 6.2831853); }
vec3 eclipseLight(vec2 uv, float q, float r) {
    vec3 c = vec3(0.0);
    vec2 n = q > 1e-6 ? uv / q : vec2(0.0, 1.0);
    if (uThin > 0.0) {
        float b = dot(n, uMoon.xy);
        float far = b + sqrt(max(b * b - dot(uMoon.xy, uMoon.xy) + uMoon.z * uMoon.z, 0.0));
        float w = max(uSunR - far, 0.0);
        // One-pixel tent (unit integral) centred a quarter pixel outside the drawn limb.
        float k = max(1.0 - abs(r - uCoreR - 0.25 * uEdge) / uEdge, 0.0) / uEdge;
        c += uLimbColor * (w * k * uThin);
    }
    if (uTotality > 0.0 || uChromo > 0.0) {
        float rho = max(r / uSunR, 1.0);
        float cth = dot(n, uPoleUv);
        float sth = n.x * uPoleUv.y - n.y * uPoleUv.x;
        float pa = atan(sth, cth);
        float eq = sth * sth;                         // 1 on the solar equator, 0 at the poles
        // Chromosphere (0.012 R☉, at least 2 px) and prominences, in drawn radii.
        float hgt = r / uCoreR - 1.0;
        float px = uEdge / uCoreR;
        float hc = max(0.012, 2.5 * px);
        float chromo = smoothstep(-px, 0.0, hgt) * (1.0 - smoothstep(0.7 * hc, hc, hgt));
        vec4 dp = eclWrap(pa - uPromPA) / uPromW;
        vec4 ph = max(uPromH, 2.0 * px) * max(1.0 - 0.5 * dp * dp, 0.0);
        vec4 prom = exp(-0.7 * dp * dp) * (1.0 - smoothstep(vec4(0.75), vec4(1.0), hgt / max(ph, vec4(1e-4)))) * step(0.0, hgt);
        float fl = eclNoise(vec2(pa * 29.921129, hgt * 60.0), 188.0);
        float pink = clamp(chromo * uChromo + dot(prom, vec4(1.0)) * (0.6 + 0.8 * fl) * uTotality, 0.0, 1.0);
        vec3 cor = vec3(0.0);
        if (uTotality > 0.0) {
            // Outer corona stretched to its minimum size, flattened along the equator further out.
            float rc = 1.0 + (rho - 1.0) / uCorStretch;
            float re = 1.0 + (rc - 1.0) / (1.0 + 2.2 * uCorFlat * eq * smoothstep(1.1, 2.2, rc));
            float L = log(max(re, 1.0));
            float I = 0.0532 * exp(-2.5 * L) + 1.425 * exp(-7.0 * L) + 2.565 * exp(-17.0 * L);
            // Helmet streamers: lobes in position angle that narrow into stalks outward.
            float Lc = log(max(rc, 1.0));
            vec4 d = eclWrap(pa - uStrPA);
            vec4 wd = uStrW * (0.35 + 0.65 * exp(-0.9 * Lc));
            float st = dot(uStrG, exp(-(d * d) / (wd * wd)));
            I *= 1.0 + st * smoothstep(1.03, 1.4, rc) * (0.5 + 1.6 * Lc);
            // Polar regions: fainter further out, combed into plumes.
            float pole = (1.0 - eq) * (1.0 - eq);
            float plume = eclNoise(vec2(pa * 11.459156, 0.0), 72.0);
            I *= mix(1.0, 0.45 + 1.3 * plume * plume, pole * smoothstep(1.04, 1.5, rc));
            // Fibrous texture along the field: fine in angle, slow in log ρ, stronger outward.
            float fib = eclNoise(vec2(pa * 25.464791, Lc * 3.0), 160.0) + 0.5 * eclNoise(vec2(pa * 50.929582, Lc * 6.0 + 7.0), 320.0);
            I *= 1.0 + (fib - 0.75) * mix(0.25, 0.5, smoothstep(1.1, 2.0, rc));
            // Display: 1.05·I^0.743 puts the inner corona (ρ 1.08) near 1.5, so only a thin ring
            // blooms; near 4 it bloomed a grey veil over the Moon and drowned the pink.
            float disp = 1.05 * exp(0.743 * log(max(I, 1e-9)));
            vec3 tint = mix(vec3(1.0, 0.94, 0.86), vec3(0.94, 0.96, 1.0), smoothstep(1.2, 3.0, rc));
            cor = uCoronaColor * tint * (disp * uTotality);
        }
        // H-alpha pink over the corona (display-referred: added to the near-white inner corona, ACES
        // turned it white), saturated and just above the bloom threshold.
        c += mix(cor, uCoronaColor * vec3(1.9, 0.13, 0.28), pink);
    }
    return pcFinite(c);
}
#endif
`;

/**
 * Limb-darkened HDR core (at least a few px wide) plus a two-scale glow that fades at the quad edge.
 * Premultiplied output (blend ONE, ONE_MINUS_SRC_ALPHA): the glow is purely additive, and the core
 * hides uOcclude of the sky behind it. In sky view the real disc outshines the air in front of it
 * many times over; added to a sky of similar display brightness, a low Sun's extinction colour
 * washed out to cream under ACES. The Sun's material adds the totality terms (ECLIPSE_CHUNK).
 *
 * Refraction (sky view, uRefrV.w > 0): the quad is centred on the lifted direction (DISC_VERT's
 * infinityClip); each fragment's apparent altitude is mapped back to true altitude with Bennett's
 * formula (photometry.js refractionFromApparentDeg) before the disc test, so a low Sun is a
 * flattened ellipse whose lower limb is squeezed most. The glow stays round.
 */
export const DISC_FRAG = /* glsl */`
uniform float uTanR;
uniform float uCoreR;
uniform float uEdge;
uniform vec3 uCoreColor;
uniform vec3 uGlowColor;
uniform float uGlowScale;
uniform float uGlowGain;
uniform float uOcclude;
// xy: the local vertical on screen (unit, quad axes); z: apparent altitude of the centre (deg);
// w: refraction strength (the view blend; 0 = a round disc).
uniform vec4 uRefrV;
varying vec2 vUv;
${ECLIPSE_CHUNK}
float bennettDeg(float h) {
    float hd = max(h, -1.0);
    return 1.0 / (60.0 * tan(radians(hd + 7.31 / (hd + 4.4))));
}
void main() {
    float q = length(vUv);
    if (q >= 1.0) discard;
    vec2 uv = vUv;
    if (uRefrV.w > 0.0) {
        float va = dot(vUv, uRefrV.xy) * uTanR;
        float ha = uRefrV.z + degrees(va);
        float vt = radians(ha - uRefrV.w * bennettDeg(ha) - (uRefrV.z - uRefrV.w * bennettDeg(uRefrV.z)));
        uv += uRefrV.xy * ((vt - va) / uTanR);
    }
    float qt = length(uv);
    float r = q * uTanR;
    float rt = qt * uTanR;
    float x = clamp(rt / uCoreR, 0.0, 1.0);
    float limb = 1.0 - 0.6 * (1.0 - sqrt(1.0 - x * x));
    float disc = 1.0 - smoothstep(uCoreR - uEdge, uCoreR + uEdge, rt);
    float glow = uGlowGain * (exp(-r / uGlowScale) + 0.12 * exp(-r / (4.0 * uGlowScale)));
    float win = 1.0 - smoothstep(0.65, 1.0, q);
    glow *= win;
    vec3 ecl = vec3(0.0);
#ifdef SUN_ECLIPSE
    ecl = eclipseLight(uv, qt, rt) * win;
#endif
    gl_FragColor = vec4(uCoreColor * (disc * limb) + uGlowColor * glow + ecl, uOcclude * disc * limb);
    ${TONE}
}
`;

/**
 * Planet glyphs: one instanced quad per planet, sized in pixels from the live magnitude.
 * iParams: x = core radius (CSS px), y = intensity, z = diffraction spikes (0/1), w = visible (0/1).
 */
export const GLYPH_VERT = /* glsl */`
uniform vec2 uViewport;
uniform float uDpr;
attribute vec3 iDir;
attribute vec3 iColor;
attribute vec4 iParams;
varying vec2 vPx;
varying vec3 vColor;
varying vec3 vParams;
varying float vExt;
${INFINITY_VERT_CHUNK}
void main() {
    float R = iParams.x * uDpr;
    float ext = R * (iParams.z > 0.5 ? 6.5 : 3.5) + 2.0 * uDpr;
    vec4 c = infinityClip(normalize(iDir));
    c.xy += position.xy * ext * 2.0 / uViewport * c.w;
    gl_Position = iParams.w > 0.5 ? c : vec4(2.0, 2.0, 2.0, 1.0);
    vPx = position.xy * ext;
    vExt = ext;
    vColor = iColor;
    vParams = vec3(R, iParams.y, iParams.z);
}
`;

/** Crisp anti-aliased disc (so planets read differently from Gaussian stars), soft halo, spikes. */
export const GLYPH_FRAG = /* glsl */`
uniform float uDpr;
uniform float uExposure;
varying vec2 vPx;
varying vec3 vColor;
varying vec3 vParams;
varying float vExt;
void main() {
    float R = vParams.x;
    float r = length(vPx);
    float rc = 0.5 * R;
    float disc = 1.0 - smoothstep(rc - 0.7 * uDpr, rc + 0.7 * uDpr, r);
    float halo = 0.30 * exp(-r / (0.85 * R)) + 0.035 * exp(-r / (1.6 * R));
    vec3 col = mix(vColor, vec3(1.0), 0.45) * disc + vColor * halo;
    if (vParams.z > 0.5) {
        vec2 a = abs(vPx);
        float w = 0.5 * uDpr;
        float len = 1.5 * R;
        float spike = exp(-a.y / w - a.x / len) + exp(-a.x / w - a.y / len);
        col += vColor * spike * 0.4;
    }
    // Radial window to exactly zero inside the quad, so no box outline can show (bloom amplifies it).
    col *= 1.0 - smoothstep(0.55, 0.98, r / vExt);
    float k = vParams.y * uExposure;
    if (k * (disc + halo) < 0.0005 && vParams.z < 0.5) discard;
    gl_FragColor = vec4(col * k, 1.0);
    ${TONE}
}
`;

/** Selection reticle: a pixel-sized quad at infinity around the selected body. */
export const RETICLE_VERT = /* glsl */`
uniform vec3 uDir;
uniform vec2 uViewport;
uniform float uRadius;
varying vec2 vPx;
${INFINITY_VERT_CHUNK}
void main() {
    float ext = uRadius + 8.0;
    vec4 c = infinityClip(normalize(uDir));
    c.xy += position.xy * ext * 2.0 / uViewport * c.w;
    gl_Position = c;
    vPx = position.xy * ext;
}
`;

/** Thin ring with four diagonal gaps and four inward ticks at the cardinal angles; rotates on acquire. */
export const RETICLE_FRAG = /* glsl */`
uniform float uRadius;
uniform float uDpr;
uniform float uAlpha;
uniform float uRot;
uniform vec3 uColor;
varying vec2 vPx;
const float HALF_PI = 1.5707963;
void main() {
    float r = length(vPx);
    float w = 0.75 * uDpr;
    float ring = clamp(w + 0.5 - abs(r - uRadius), 0.0, 1.0);
    float ang = (r > 1e-4 ? atan(vPx.y, vPx.x) : 0.0) + uRot;   // atan(0, 0) is undefined
    float f = fract(ang / HALF_PI);
    ring *= smoothstep(0.07, 0.11, abs(f - 0.5));
    // Inward ticks on the axes: perpendicular distance from the nearest axis ray.
    float g = abs(fract(ang / HALF_PI + 0.5) - 0.5) * HALF_PI * r;
    float tick = clamp(w + 0.5 - g, 0.0, 1.0) * step(uRadius - 5.0 * uDpr, r) * step(r, uRadius);
    float a = max(ring, tick) * uAlpha;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(uColor, a);
    ${TONE}
}
`;

/**
 * Moon (true scale, IAU orientation): standard mesh transform; world normal and position out. In
 * sky view each vertex's direction from the camera is lifted by refraction (REFRACT_CHUNK), which
 * also flattens a low Moon; vPw keeps the true position for the lighting and the umbra.
 *
 * uNearZ > 0 (lunar orbit, FrameInfo.moonFront): the camera's near plane sits ~47 R out for the
 * Earth's sake, so the Moon, a few hundred km away, is pinned to depth uNearZ / 2 instead: clipped
 * at the eye (z + w = uNearZ·w ≥ 0 ⟺ w ≥ 0) and in front of everything. A convex, back-face-culled
 * sphere needs no depth order of its own.
 */
export const MOON_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vNw;
varying vec3 vPw;
varying vec3 vPm;
varying vec3 vPr;
uniform float uNearZ;
${REFRACT_CHUNK}
void main() {
    vUv = uv;
    vPm = position;                       // Moon-fixed (the relief's noise)
    vPr = mat3(modelMatrix) * position;   // world axes about the Moon's centre (its derivatives)
    vNw = normalize(mat3(modelMatrix) * normal);
    vec4 pw = modelMatrix * vec4(position, 1.0);
    vPw = pw.xyz;
    vec3 rel = pw.xyz - cameraPosition;
    float L = length(rel);
    if (uRefrK > 0.0 && L > 1e-6) pw.xyz = cameraPosition + refractLift(rel / L) * L;
    gl_Position = projectionMatrix * viewMatrix * pw;
    if (uNearZ > 0.0) gl_Position.z = (uNearZ - 1.0) * gl_Position.w;
}
`;

/**
 * Lommel–Seeliger lunar photometry (phase correct by construction from any viewpoint), opposition
 * surge, earthshine on the Earth-facing hemisphere, and the lunar eclipse: the Sun's disc as seen
 * from each surface point is occulted by Earth (radius +1.2 % for the atmosphere, Danjon), with the
 * umbra lit by red refracted sunset light, darker toward the centre, and a faint turquoise fringe
 * (ozone) at its edge. Drawn additively after a depth-only pass, so in the daytime sky the unlit
 * part of the Moon shows the sky behind it, as it does in reality.
 */
export const MOON_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uSunDir;
uniform vec3 uMoonPos;
uniform float uSunE;
uniform float uAlbedo;
uniform float uEarthshine;
uniform vec3 uTint;
uniform float uUmbraGain;
uniform float uSunR;        // the Sun's true angular radius (astro/bodies.js sunAngularRadius)
uniform float uNearZ;       // > 0 in lunar orbit: the close-up relief below
varying vec2 vUv;
varying vec3 vNw;
varying vec3 vPw;
varying vec3 vPm;
varying vec3 vPr;
float moonHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float moonNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(moonHash(i), moonHash(i + vec3(1, 0, 0)), f.x), mix(moonHash(i + vec3(0, 1, 0)), moonHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(moonHash(i + vec3(0, 0, 1)), moonHash(i + vec3(1, 0, 1)), f.x), mix(moonHash(i + vec3(0, 1, 1)), moonHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// Close-up relief for lunar orbit: the 1024 map is ~11 km a texel, so from 150 km up the foreground
// is a blur. Rough terrain from 20 km down to 2.5 km (four octaves of value noise on the Moon's own
// surface, so it does not swim) as an albedo mottle and, through screen-space derivatives, a bump.
float moonRelief(vec3 pm) {
    vec3 p = pm * 320.0;
    float h = 0.0, a = 0.5;
    for (int k = 0; k < 4; k++) {
        float n = moonNoise(p);
        h += a * (1.0 - abs(2.0 * n - 1.0));   // ridged: sharp crests, rounded hollows
        p = p * 2.03 + 17.1;
        a *= 0.5;
    }
    return h;
}
float discVisibleG5(float rs, float ro, float d) {
    if (d >= rs + ro) return 1.0;
    if (d <= abs(ro - rs)) return ro >= rs ? 0.0 : 1.0 - (ro * ro) / (rs * rs);
    float a = rs * rs * acos(clamp((d * d + rs * rs - ro * ro) / (2.0 * d * rs), -1.0, 1.0))
            + ro * ro * acos(clamp((d * d + ro * ro - rs * rs) / (2.0 * d * ro), -1.0, 1.0))
            - 0.5 * sqrt(max((-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro), 0.0));
    return 1.0 - a / (3.14159265 * rs * rs);
}
void main() {
    vec3 N = normalize(vNw);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vPw);
    vec3 albedo = texture2D(uMap, vUv).rgb * uAlbedo;
    if (uNearZ > 0.0) {
        float h = moonRelief(vPm);
        // Faded out toward the limb, where the foreshortened noise would shimmer.
        float w = smoothstep(0.03, 0.2, dot(N, V));
        albedo *= 1.0 + w * 0.55 * (h - 0.62);
        // Bump (Mikkelsen's surface-gradient form): heights in Earth radii, ~1.5 km of relief.
        // Derivatives of the Moon-centred position: 60 R out, float world positions are 25 m coarse.
        vec3 dpx = dFdx(vPr), dpy = dFdy(vPr);
        float hs = h * 2.4e-4 * w;
        float dhx = dFdx(hs), dhy = dFdy(hs);
        vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
        float det = dot(dpx, r1);
        if (abs(det) > 1e-30) N = normalize(abs(det) * N - sign(det) * (dhx * r1 + dhy * r2));
    }
    float mu0 = max(dot(N, L), 0.0);
    float mu = max(dot(N, V), 1e-3);
    float g = acos(clamp(dot(L, V), -1.0, 1.0));
    // Lommel–Seeliger, capped: at grazing view angles it tends to 2 and blooms into a hot spot.
    float ls = min(2.0 * mu0 / (mu0 + mu), 1.3);
    vec3 col = albedo * uSunE * 1.2 * ls * (1.0 + 0.15 * exp(-g / 0.1));
    // Lunar eclipse.
    float dE = length(vPw);
    vec3 toEarth = -vPw / dE;
    float er = asin(min(1.0, 1.012 / dE));
    float sep = acos(clamp(dot(toEarth, L), -1.0, 1.0));
    float vis = discVisibleG5(uSunR, er, sep);
    if (vis < 1.0) {
        float umbra = er - uSunR;
        float depth = clamp((umbra - sep) / max(umbra, 1e-4), 0.0, 1.0);
        // Copper red, brighter toward the umbra's edge. Physically ~1e-4 of the full Moon, but
        // like the eye (or a camera) we expose for it; below ~10 % ACES' toe crushes it to black.
        vec3 red = vec3(0.62, 0.22, 0.08) * mix(0.55, 0.16, sqrt(depth));
        float zf = (sep - umbra) / 0.0011;
        float fringe = exp(-zf * zf);   // not pow(x, 2.0): undefined for x < 0
        // The penumbra keeps the neutral light of the Sun's visible part (vis); the refracted
        // copper only shows where the Sun is (nearly) hidden, and while part of the Moon is still
        // sunlit the eye, adapted to that bright cap, sees the umbra far darker (uUmbraGain).
        float redW = (1.0 - smoothstep(0.0, 0.1, vis)) * uUmbraGain;
        col = col * vis + albedo * ls * uSunE * redW * (red + vec3(0.08, 0.30, 0.42) * 0.05 * fringe);
    }
    // Earthshine: Earth's phase seen from the Moon is full at new Moon.
    vec3 mdir = normalize(uMoonPos);
    float earthPhase = 0.5 + 0.5 * dot(mdir, L);
    col += albedo * vec3(0.80, 0.88, 1.0) * uEarthshine * earthPhase * (0.25 + 0.75 * max(dot(N, -mdir), 0.0));
    col *= uTint;
    // Soft highlight knee (asymptote 0.85): the Moon never crosses the bloom threshold, so the
    // texture's bright polar smear cannot flare.
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    if (lum > 0.55) col *= (0.55 + (lum - 0.55) / (1.0 + (lum - 0.55) / 0.3)) / lum;
    gl_FragColor = vec4(col, 1.0);
    ${TONE}
}
`;

/**
 * Lens flare quads in NDC (SPEC E.5): element 0 is the starburst at the Sun, the rest are ghosts
 * along the Sun→centre axis (three.js Lensflare convention: position = sun·(1 − 2·distance)).
 * aElem: x = element index, y = size (CSS px), z = axis distance (<0: at the Sun), w = ghost hue (1…4).
 */
export const FLARE_VERT = /* glsl */`
uniform vec2 uSunNdc;
uniform vec2 uViewport;
uniform float uDpr;
attribute vec4 aElem;
varying vec2 vUv;
varying float vIdx;
varying float vTint;
void main() {
    vec2 centre = aElem.z < 0.0 ? uSunNdc : uSunNdc * (1.0 - 2.0 * aElem.z);
    vec2 halfNdc = vec2(aElem.y * uDpr) / uViewport;
    gl_Position = vec4(centre + position.xy * halfNdc, 0.0, 1.0);
    vUv = position.xy * 0.5 + 0.5;
    vIdx = aElem.x;
    vTint = aElem.w;
}
`;

/**
 * @see FLARE_VERT. Procedural, no textures. The starburst is a bright core and halo, six fine
 * diffraction spikes (a six-blade aperture) with six fainter ones between them, and a faint
 * spectral ring (each channel at a slightly different radius). A ghost is an image of the
 * hexagonal aperture: a faint, evenly lit hexagon with a brighter rim whose red, green and blue
 * edges sit at slightly different sizes (lateral colour), lightly tinted by the coatings.
 */
export const FLARE_FRAG = /* glsl */`
uniform vec3 uTint;
uniform float uIntensity;
varying vec2 vUv;
varying float vIdx;
varying float vTint;
vec3 ghostHue(float k) {
    // Anti-reflection coatings tint ghosts in clean, pale hues: violet, teal, amber, rose.
    if (k < 1.5) return vec3(0.80, 0.78, 1.0);
    if (k < 2.5) return vec3(0.70, 1.0, 0.92);
    if (k < 3.5) return vec3(1.0, 0.86, 0.62);
    return vec3(1.0, 0.74, 0.82);
}
// Distance-like function of a regular hexagon of inradius 1 (turned by rot), from its centre.
float hexDist(vec2 p, float rot) {
    float c = cos(rot), s = sin(rot);
    vec2 q = abs(vec2(c * p.x - s * p.y, s * p.x + c * p.y));
    return max(dot(q, vec2(0.5, 0.8660254)), q.x);
}
// One ghost channel: the evenly lit aperture and its rim, at size R.
float ghostShape(float d, float R, float aa) {
    float inside = 1.0 - smoothstep(R - aa, R + aa, d);
    float rim = exp(-0.5 * (d - R + 1.5 * aa) * (d - R + 1.5 * aa) / (aa * aa));
    return 0.30 * inside + rim;
}
void main() {
    vec3 c;
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float win = 1.0 - smoothstep(0.55, 0.98, r);
    if (vIdx < 0.5) {
        float th = (r > 1e-5) ? atan(p.y, p.x) : 0.0;   // atan(0, 0) is undefined
        float core = 1.6 * exp(-r / 0.022) + 0.30 * exp(-r / 0.075) + 0.05 * exp(-r / 0.28);
        float spikes = pow(abs(cos(3.0 * th + 0.5236)), 360.0) * exp(-r / 0.24)
                     + 0.35 * pow(abs(sin(3.0 * th + 0.5236)), 900.0) * exp(-r / 0.13);
        float ring = exp(-0.5 * (r - 0.36) * (r - 0.36) / 0.0004);
        vec3 iris = vec3(exp(-0.5 * (r - 0.372) * (r - 0.372) / 0.0003),
                         exp(-0.5 * (r - 0.360) * (r - 0.360) / 0.0003),
                         exp(-0.5 * (r - 0.348) * (r - 0.348) / 0.0003));
        c = uTint * ((core + 0.55 * spikes * smoothstep(0.0, 0.03, r)) * (win * win) + 0.035 * iris + 0.004 * ring);
    } else {
        float d = hexDist(p, 0.2);
        float aa = max(fwidth(d), 0.012);
        vec3 g = vec3(ghostShape(d, 0.80, aa), ghostShape(d, 0.78, aa), ghostShape(d, 0.76, aa));
        c = g * uTint * ghostHue(vTint) * 0.028;
        c *= 1.0 - smoothstep(0.86, 0.98, r);
    }
    gl_FragColor = vec4(c * uIntensity, 1.0);
    ${TONE}
}
`;
