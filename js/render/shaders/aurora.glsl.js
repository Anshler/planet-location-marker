/**
 * Aurora (docs/ASTRONOMY.md "Aurora"). The ovals come from js/astro/geomag.js: a 48-float table
 * of equatorward and poleward edges over magnetic local time (Starkov 1994), placed by the IGRF
 * dipole and the Sun. Everything inside the band (arcs, folds, rays, their drift) is illustrative.
 *
 * Two renderings of the same column emission (green 557.7 nm, red 630.0 nm), so they hand over
 * without a seam:
 *  - `auroraFace` (AURORA_CHUNK), an emission term in the surface and cloud shaders, every tier:
 *    the oval seen from above, drawn where the view ray crosses the 110 km shell (so it has the
 *    right parallax) and brightened by the slant of the path through the layer;
 *  - the volumetric shell (high, max): a FrontSide sphere at r = 1.05 that marches the view ray
 *    through 90–300 km with the vertical profiles below, so curtains stand up above the limb. The
 *    planet is clipped analytically (the march stops at the 90 km shell), and the shell takes over
 *    from the face term as the view turns oblique: weights smoothstep(0.15, 0.45, n·V) and its
 *    complement, at the same 110 km point in both shaders (AURORA_SHELL in the surface shaders).
 *
 * Animation runs on simulated time only (uAur.y, the phase of a 65536 s cycle, with every drift a
 * whole number of laps per cycle so the wrap is seamless): a paused app stays still, and at Live
 * rate the curtains barely move between the half-second snapshots. uAur.z fades the fine structure
 * out at fast time-lapse rates, where it would only flicker.
 */
import { COMMON } from './common.glsl.js';

/** Uniforms and functions shared by the surface, cloud and shell shaders. Requires COMMON. */
export const AURORA_CHUNK = /* glsl */ `
#ifndef PC_AURORA_GLSL
#define PC_AURORA_GLSL
uniform vec3 uAurPole;        // geomagnetic north pole (world, unit)
uniform vec3 uAurNoon;        // unit, perpendicular to uAurPole, toward the Sun (magnetic noon)
uniform float uAurOval[48];   // [h] equatorward, [24 + h] poleward edge (geomagnetic latitude, deg) at MLT h
uniform vec4 uAur;            // (strength, animation phase in [0, 1), fine detail in [0, 1], storm share)

const float AUR_R = 1.0173;                       // 110 km: the green emission peak
const vec3 AUR_GREEN = vec3(0.22, 1.0, 0.38);     // 557.7 nm (O)
const vec3 AUR_RED = vec3(1.0, 0.10, 0.22);       // 630.0 nm (O, high up)

// Smooth periodic value noise on [0, 1): n lattice cells per period.
float aurNoise(float x, float n, float seed) {
    float t = fract(x) * n;
    float i = floor(t);
    float f = t - i;
    float a = hash12(vec2(mod(i, n), seed));
    float b = hash12(vec2(mod(i + 1.0, n), seed));
    return mix(a, b, f * f * (3.0 - 2.0 * f));
}

// Column emission of the oval above unit direction n (world): about 1 on a bright arc. Also returns
// the red share and a ray value in [0, 1] (the shell makes bright rays taller). px: a pixel's
// footprint in turns of magnetic local time (fades the rays).
float aurStrength(vec3 n, float px, out float red, out float ray) {
    red = 0.0;
    ray = 0.5;
    float m = abs(dot(n, uAurPole));
    if (m < 0.7) return 0.0;   // below 44° geomagnetic: even the storm oval's glow stops near 50°
    float lat = degrees(asin(clamp(m, 0.0, 1.0)));
    vec3 dusk = cross(uAurPole, uAurNoon);
    float mlt = 12.0 + atan(dot(n, dusk), dot(n, uAurNoon)) * (12.0 / PI);
    float h = mod(mlt, 24.0);
    float i0 = floor(h);
    float w = h - i0;
    int a = int(clamp(i0, 0.0, 23.0));
    int b = a == 23 ? 0 : a + 1;
    float eq = mix(uAurOval[a], uAurOval[b], w);
    float po = mix(uAurOval[a + 24], uAurOval[b + 24], w);
    float u = (lat - eq) / max(po - eq, 1.0);   // 0 at the equatorward edge, 1 at the poleward edge
    if (u < -1.0 || u > 1.3) return 0.0;

    float x = h / 24.0;
    float ph = uAur.y;
    float det = uAur.z;
    // Brightest before magnetic midnight (substorms), faint at the dayside cusp.
    float sect = max(0.5 + 0.5 * cos((h - 23.0) * (PI / 12.0)), 0.0);
    float nightK = 0.18 + 0.82 * sect * sect;
    float band = smoothstep(-0.2, 0.08, u) * (1.0 - smoothstep(0.75, 1.15, u));
    float diffuse = 0.1 * smoothstep(-0.7, 0.0, u) * (1.0 - smoothstep(0.0, 0.4, u));
    // Three folded arcs along the oval, each fading in and out along it, drifting with simulated
    // time; a shared large fold plus a curl of their own keeps them from running parallel.
    float fold = aurNoise(x + 3.0 * ph, 24.0, 1.0) * 0.6 + aurNoise(x - 5.0 * ph, 37.0, 2.0) * 0.4;
    float arcs = 0.0;
    for (int k = 0; k < 3; k++) {
        float fk = float(k);
        float own = aurNoise(x + (11.0 - 6.0 * fk) * ph, 53.0 + 31.0 * fk, 20.0 + fk) - 0.5;
        float c = 0.15 + 0.32 * fk + 0.4 * (fold - 0.5) + 0.14 * own;
        float d = (u - c) / (0.045 + 0.02 * fk);
        float amp = smoothstep(0.3, 0.85, aurNoise(x + (7.0 + 4.0 * fk) * ph, 9.0 + 5.0 * fk, 3.0 + fk));
        arcs += amp * exp(-d * d);
    }
    // Patches of activity along the oval.
    float patchK = 0.3 + 0.7 * smoothstep(0.2, 0.8, aurNoise(x - 2.0 * ph, 7.0, 8.0));
    // Rays: fine striations along the arcs, gone once they are smaller than a pixel.
    float rayVis = 1.0 - smoothstep(0.3, 0.9, px * 720.0);
    ray = aurNoise(x + 41.0 * ph, 720.0, 9.0);
    float rays = 1.0 + det * rayVis * 1.2 * (ray - 0.5);
    red = clamp(0.08 + 0.3 * smoothstep(0.55, 1.1, u) + 0.4 * (1.0 - sect)
        + 0.5 * uAur.w * (1.0 - smoothstep(-0.6, 0.4, u)), 0.0, 1.0);
    return (band * patchK * mix(0.5, 0.1 + 1.1 * arcs, det) * rays + diffuse) * nightK;
}

// The oval seen from above at a surface or cloud fragment (normal Ng, unit V toward the camera,
// L toward the Sun): the column over the point where the view ray crosses the 110 km shell, on
// the night side only. Linear HDR; stays under the bloom threshold except in the storm setting.
vec3 auroraFace(vec3 Ng, vec3 V, vec3 L) {
    vec3 rd = -V;
    vec2 ts = raySphere(cameraPosition, rd, AUR_R);
    vec3 n = ts.x > 0.0 && ts.y > ts.x ? normalize(cameraPosition + rd * ts.x) : Ng;   // (1e9, -1e9) = miss
    float px = length(fwidth(n)) * 0.41;   // radians per pixel → turns of MLT at ~67° latitude
    if (uAur.x <= 0.0) return vec3(0.0);
    float dark = 1.0 - smoothstep(-0.12, 0.04, dot(n, L));
    if (dark <= 0.0) return vec3(0.0);
    float nov = max(dot(n, V), 0.0);
    float slant = min(1.0 / max(nov, 0.05), 2.5);
#ifdef AURORA_SHELL
    slant *= smoothstep(0.15, 0.45, nov);   // the volumetric shell draws the oblique share
#endif
    float red, ray;
    float s = aurStrength(n, px, red, ray);
    return mix(AUR_GREEN, AUR_RED, red) * (s * slant * dark * uAur.x);
}
#endif
`;

const vertex = /* glsl */ `
varying vec3 vPosW;

void main() {
    vec4 pw = modelMatrix * vec4(position, 1.0);
    vPosW = pw.xyz;
    gl_Position = projectionMatrix * viewMatrix * pw;
}
`;

const fragment = /* glsl */ `
uniform vec3 uSunDirW;
uniform float uIntensity;   // 1 - ground cover (sky view)
uniform float uPxAng;       // radians per pixel
uniform float uAurSinMin;   // sin of the lowest latitude the oval (and its diffuse glow) reaches

varying vec3 vPosW;

${COMMON}
${AURORA_CHUNK}

#ifndef STEPS
#define STEPS 24
#endif
#define HALF_STEPS ((STEPS + 1) / 2)

const float AUR_BOT = 1.0141;   // 90 km
const float AUR_TOP = 1.0471;   // 300 km
const vec3 AUR_VIOLET = vec3(0.55, 0.18, 1.0);   // 427.8 nm (N2+) lower fringe, strong activity

// Vertical profiles per Earth radius, each integrating to 1 over the column, so the shell's
// face-on brightness equals auroraFace's: green from a sharp lower edge at ~100 km, peaking at
// 110 km, with an upward tail whose scale height follows the rays (tall rays, a picket fence at
// the limb); red around 235 km; a thin violet fringe at the bottom edge.
vec3 aurProfile(float h, float ray) {
    float hg = 0.003 + 0.007 * ray * ray;
    float g = smoothstep(0.0150, 0.0176, h) * exp(-max(h - 0.0176, 0.0) / hg) / (0.0013 + hg);
    float dr = (h - 0.037) / 0.009;
    float dv = (h - 0.0158) / 0.0010;
    return vec3(g, exp(-dr * dr) / 0.016, exp(-dv * dv) / 0.00177);
}

void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vPosW - ro);
    vec3 col = vec3(0.0);
    vec2 to = raySphere(ro, rd, AUR_TOP);
    if (uAur.x > 0.0 && to.y > 0.0) {
        bool hit = raySphere(ro, rd, 1.0).x > 0.0;
        // Over the disc the surface shaders draw the face-on share (same 110 km point and weight).
        float w = 1.0;
        if (hit) w = 1.0 - smoothstep(0.15, 0.45, dot(normalize(ro + rd * raySphere(ro, rd, AUR_R).x), -rd));
        if (w > 0.0) {
            vec3 L = normalize(uSunDirW);
            float tm = -dot(ro, rd);                              // closest approach
            float hc = length(ro + rd * tm) - 1.0;                // its height (< 0: hits the planet)
            float hLo = max(hc, AUR_BOT - 1.0), hHi = AUR_TOP - 1.0;
            float span = hHi - hLo;
            float jit = hash12(gl_FragCoord.xy);
            // March in altitude, not distance: each emitting layer gets samples however long the
            // chord. h = hLo + span·s² (dense low down, where the green is); t = tm ∓ √((1+h)² − (1+hc)²).
            // dt/ds stays finite at a tangent point. A ray that hits the planet only has the near
            // half; one that passes below 90 km has a near and a far half.
            for (int k = 0; k < 2; k++) {
                if (k == 1 && hit) break;
                float dir = k == 0 ? -1.0 : 1.0;
                for (int i = 0; i < HALF_STEPS; i++) {
                    float s = (float(i) + jit) / float(HALF_STEPS);
                    float hh = hLo + span * s * s;
                    float q = sqrt(max((hh - hc) * (2.0 + hh + hc), 1e-12));
                    float t = tm + dir * q;
                    if (t <= 0.0) continue;                          // behind the camera
                    vec3 n = (ro + rd * t) / (1.0 + hh);
                    if (abs(dot(n, uAurPole)) < uAurSinMin) continue;
                    float dark = 1.0 - smoothstep(-0.12, 0.04, dot(n, L));
                    if (dark <= 0.0) continue;
                    float red, ray;
                    float st = aurStrength(n, uPxAng * t * 0.41, red, ray);
                    if (st <= 0.0) continue;
                    vec3 pr = aurProfile(hh, ray);
                    // dt = (1 + h) / q · dh, dh = 2·span·s·ds
                    float ds = (1.0 + hh) / max(q, 1e-4) * 2.0 * span * s / float(HALF_STEPS);
                    col += (AUR_GREEN * ((1.0 - red) * pr.x) + AUR_RED * (red * pr.y) + AUR_VIOLET * (0.3 * uAur.w * pr.z))
                         * (st * dark * ds);
                }
            }
            col *= w * uAur.x * uIntensity;
            // Edge-on paths are tens of times the vertical column: soft-cap so the limb glows
            // without blowing the bloom out.
            float peak = max(col.r, max(col.g, col.b));
            col *= peak > 1.2 ? (1.2 + 0.6 * log(max(peak / 1.2, 1.0))) / max(peak, 1.2) : 1.0;
        }
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/** Aurora shell ShaderMaterial sources. */
export const AURORA_SHADER = { vertex, fragment };
export { vertex, fragment };
