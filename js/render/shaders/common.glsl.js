/**
 * Shared GLSL helpers (SPEC §C.5, formulas in §E.2).
 *
 * `COMMON` is safe in both vertex and fragment stages. It is include-guarded,
 * so concatenating it twice is harmless, and it defines `PI` with exactly the
 * same token sequence as three's `<common>` chunk, so a benign redefinition
 * never trips the GLSL preprocessor.
 *
 * Do not combine `COMMON` with three's `<bsdfs>` chunk in one shader: both
 * declare `D_GGX(float, float)`.
 *
 * `SURFACE_FRAG` holds fragment-only helpers (they use screen-space derivatives)
 * for sampling equirectangular maps without pole pinching or dateline seams.
 */

export const COMMON = /* glsl */ `
#ifndef PC_COMMON_GLSL
#define PC_COMMON_GLSL

#ifndef PI
#define PI 3.141592653589793
#endif

// Ray / sphere (centre at the origin). Returns (t0, t1), or (1e9, -1e9) on a miss.
// Uses the closest-approach form, which keeps precision when |ro| >> r (camera far away).
vec2 raySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    vec3 q = ro - b * rd;
    float h = r * r - dot(q, q);
    if (h < 0.0) return vec2(1e9, -1e9);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
}

// Visible fraction of a disc of angular radius rs (the Sun) when a disc of angular
// radius ro (the occluder) sits at angular separation sep. Mirrors js/astro/shadow.js.
float discVisible(float rs, float ro, float sep) {
    if (sep >= rs + ro) return 1.0;
    if (sep <= abs(ro - rs)) return ro >= rs ? 0.0 : 1.0 - (ro * ro) / (rs * rs);
    float d = sep;
    float a1 = rs * rs * acos(clamp((d * d + rs * rs - ro * ro) / (2.0 * d * rs), -1.0, 1.0));
    float a2 = ro * ro * acos(clamp((d * d + ro * ro - rs * rs) / (2.0 * d * ro), -1.0, 1.0));
    float a3 = 0.5 * sqrt(max((-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro), 0.0));
    return clamp(1.0 - (a1 + a2 - a3) / (PI * rs * rs), 0.0, 1.0);
}

// Angle between two unit vectors, accurate for tiny angles (acos loses ~3e-4 rad near 1).
float angleBetween(vec3 a, vec3 b) {
    return 2.0 * asin(clamp(0.5 * length(a - b), 0.0, 1.0));
}

// Geometry-local direction (scene frame under S: +Y north, lon 0 at +X, lon +90E at -Z)
// to equirectangular uv (left edge lon -180, v = 1 at the north pole).
// atan(y, |xz|) is the well-conditioned form of asin(y) near the poles.
// At the exact north-pole vertex atan(0, 0) is undefined but finite on every backend tested (0, or
// π on Vulkan-NVIDIA for -0), and every longitude samples the same polar texel there. A guard here
// (tried) changes the compiled arithmetic and moves ~0.07 % of the globe pixels by 1-3 LSB on
// ANGLE/D3D11, so it is deliberately left out.
vec2 localDirToUv(vec3 d) {
    return vec2(atan(-d.z, d.x) / (2.0 * PI) + 0.5, atan(d.y, length(d.xz)) / PI + 0.5);
}

// Scene direction to (RA, Dec) texture uv: u = RA / 360, v = 0.5 + Dec / 180.
vec2 sceneDirToRaDecUv(vec3 d) {
    vec3 e = vec3(d.x, -d.z, d.y);
    float ra = (e.x == 0.0 && e.y == 0.0) ? 0.0 : atan(e.y, e.x);   // atan(0, 0) is undefined
    return vec2(fract(ra / (2.0 * PI)), 0.5 + atan(e.z, length(e.xy)) / PI);
}

// GGX / Trowbridge-Reitz NDF; a = alpha = roughness^2.
float D_GGX(float NoH, float a) {
    float a2 = a * a;
    float d = (NoH * a2 - NoH) * NoH + 1.0;
    return a2 / (PI * d * d + 1e-7);
}

float F_Schlick(float f0, float VoH) {
    float x = 1.0 - VoH;
    float x2 = x * x;
    return f0 + (1.0 - f0) * x2 * x2 * x;
}

// Height-correlated Smith visibility, fast approximation (Karis / Filament).
float V_SmithFast(float NoV, float NoL, float a) {
    float gv = NoL * (NoV * (1.0 - a) + a);
    float gl = NoV * (NoL * (1.0 - a) + a);
    return 0.5 / max(gv + gl, 1e-5);
}

// Sine-free hash (Dave Hoskins), [0, 1).
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

#endif
`;

/**
 * Fragment-only helpers for equirectangular surfaces. Requires `COMMON` first.
 *
 * `seamlessU` implements Tarini's trick: per 2x2 quad it picks whichever of
 * u or fract(u + 0.5) - 0.5 has the smaller screen derivative, so the mip
 * level never collapses across the atan() discontinuity at the dateline.
 * Textures must use RepeatWrapping on S (the texture store does that for 2:1 maps).
 */
export const SURFACE_FRAG = /* glsl */ `
#ifndef PC_SURFACE_FRAG_GLSL
#define PC_SURFACE_FRAG_GLSL

vec2 seamlessUv(vec2 uv) {
    float uB = fract(uv.x + 0.5) - 0.5;
    uv.x = fwidth(uv.x) <= fwidth(uB) + 1e-7 ? uv.x : uB;
    return uv;
}

// Exact per-fragment equirect uv from the interpolated local position: no pinching
// at the pole fans of SphereGeometry, and no dateline seam.
vec2 surfaceUv(vec3 pLocal) {
    return seamlessUv(localDirToUv(pLocal));
}

#endif
`;

/**
 * NaN/Inf scrub (both stages). `pcFinite(c)` maps NaN to 0 and ±Inf to ±65504 (the largest half
 * float) and leaves finite values unchanged.
 *
 * It tests the IEEE bit pattern because nothing else is reliable. FXC (ANGLE on Direct3D 11)
 * assumes floats are never NaN: it compiles isnan() and `x != x` away, and min/max/clamp with a
 * NaN operand are undefined in GLSL, so each driver does something different. A single NaN pixel in
 * the HDR scene target is enough for UnrealBloom's mip blur to spread it into a screen-sized
 * rectangle, which ACES then shows as black. Cost: a few integer ops per pixel.
 */
export const FINITE_CHUNK = /* glsl */ `
#ifndef PC_FINITE_GLSL
#define PC_FINITE_GLSL
vec3 pcFinite(vec3 c) {
    bvec3 nan = greaterThan(floatBitsToUint(c) & uvec3(0x7fffffffu), uvec3(0x7f800000u));
    c = vec3(nan.x ? 0.0 : c.x, nan.y ? 0.0 : c.y, nan.z ? 0.0 : c.z);
    return clamp(c, vec3(-65504.0), vec3(65504.0));
}
vec4 pcFinite(vec4 c) {
    bvec4 nan = greaterThan(floatBitsToUint(c) & uvec4(0x7fffffffu), uvec4(0x7f800000u));
    c = vec4(nan.x ? 0.0 : c.x, nan.y ? 0.0 : c.y, nan.z ? 0.0 : c.z, nan.w ? 0.0 : c.w);
    return clamp(c, vec4(-65504.0), vec4(65504.0));
}
#endif
`;
