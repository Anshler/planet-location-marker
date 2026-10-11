/**
 * Atmosphere (SPEC §E.3) and the shared atmosphere model used by the surface
 * and cloud shaders, so the limb, the terminator band, the haze over the disc
 * and the colour of low sunlight all come from one set of constants.
 *
 * Model: single scattering, Rayleigh + Mie (Cornette-Shanks, g = 0.76), with
 * the spec's inflated-but-optically-correct constants (scale heights 5x real,
 * beta scaled down to match vertical optical depths). Optical depth toward the
 * Sun is closed-form (Chapman grazing-incidence approximation) with a soft
 * planet shadow: smoother and cheaper than a short light march, and it yields
 * the layered sunset colours at the terminator.
 *
 * Shell shader: BackSide sphere r = 1.025, additive. Every pixel inside the
 * shell's silhouette gets exactly one fragment (the far side) and the integral
 * runs along the view ray, so mesh resolution never shows. Pixels covered by
 * the Earth fail the depth test; the surface shader's aerial perspective
 * covers those. View samples: 4 by default (low/medium, "analytic"), STEPS
 * with RAYMARCH (high, atmoSteps = 8), split evenly either side of the ray's
 * closest approach; the far half fades in just above the surface so the shell
 * meets the disc's aerial perspective without a line at the mesh silhouette. A faint airglow line rides above the
 * night limb. No discard: empty fragments add black, which keeps early depth
 * rejection behind the Earth.
 */
import { COMMON } from './common.glsl.js';

/** Sun radiance scale of the physical model (the spec's "sun intensity 22"). */
export const ATMO_SUN_I = 22.0;
/**
 * Artistic exposure applied to the model's radiance, shared by the limb (uExposure)
 * and the surface/cloud haze (uHazeE = ATMO_SUN_I * ATMO_EXPOSURE) so they match.
 */
export const ATMO_EXPOSURE = 0.6;

/** Shared atmosphere model. Requires COMMON. */
export const ATMO_MODEL = /* glsl */ `
#ifndef PC_ATMO_MODEL_GLSL
#define PC_ATMO_MODEL_GLSL

const float ATM_RP = 1.0;
const float ATM_RA = 1.025;
const float ATM_HR = 0.00625;
const float ATM_HM = 0.0025;
const vec3 ATM_BETA_R = vec3(7.4, 17.2, 42.2);   // per Earth radius
const float ATM_BETA_M = 10.0;
const float ATM_MIE_EXT = 1.1;
const float ATM_MIE_G = 0.76;

float atmPhaseR(float nu) {
    return 3.0 / (16.0 * PI) * (1.0 + nu * nu);
}

// Aerosol phase: Cornette-Shanks (g = 0.76) for the broad lobe plus a narrow
// Henyey-Greenstein (g = 0.93) diffraction peak, which real aerosols have and
// which gives the solar aureole when the Sun sits just behind the limb.
float atmPhaseM(float nu) {
    float g2 = ATM_MIE_G * ATM_MIE_G;
    float cs = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + nu * nu))
             / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * ATM_MIE_G * nu, 1e-4), 1.5));
    const float G2 = 0.93;
    float hg = (1.0 - G2 * G2) / (4.0 * PI * pow(max(1.0 + G2 * G2 - 2.0 * G2 * nu, 1e-4), 1.5));
    return 0.8 * cs + 0.2 * hg;
}

// Column densities (Rayleigh, Mie; density 1 at sea level, lengths in Earth radii)
// from altitude h toward a Sun whose zenith cosine is mu; .z = soft planet shadow.
vec3 atmSunColumns(float h, float mu) {
    float r = ATM_RP + h;
    float chR = sqrt(PI * r / (2.0 * ATM_HR));
    float chM = sqrt(PI * r / (2.0 * ATM_HM));
    float upR = ATM_HR * exp(-h / ATM_HR) / (abs(mu) + 1.0 / chR);
    float upM = ATM_HM * exp(-h / ATM_HM) / (abs(mu) + 1.0 / chM);
    if (mu >= 0.0) return vec3(upR, upM, 1.0);
    // Sun below this point's horizon: the ray dips to hLow and climbs out again.
    float hLow = r * sqrt(max(1.0 - mu * mu, 0.0)) - ATM_RP;
    float lit = smoothstep(-0.0012, 0.0025, hLow);
    float hl = max(hLow, 0.0);
    float cR = 2.0 * ATM_HR * chR * exp(-hl / ATM_HR) - upR;
    float cM = 2.0 * ATM_HM * chM * exp(-hl / ATM_HM) - upM;
    return vec3(max(cR, 0.0), max(cM, 0.0), lit);
}

// Sunlight reaching altitude h (rgb transmittance, shadow included).
vec3 atmSunTransmittance(float h, float mu) {
    vec3 c = atmSunColumns(h, mu);
    return exp(-(ATM_BETA_R * c.x + ATM_BETA_M * ATM_MIE_EXT * c.y)) * c.z;
}

// Same, normalised so that overhead sunlight is white (keeps noon colours neutral).
vec3 atmSunTint(float h, float mu) {
    return atmSunTransmittance(h, mu) / atmSunTransmittance(h, 1.0);
}

// Aerial perspective for a surface point P (unit sphere, world) seen along V
// (unit, toward the camera) with the Sun along L: the same single-scattering
// integrand as the shell, over the view path from the top of the atmosphere
// down to P (3 taps). At the silhouette this is exactly the near half of the
// shell's grazing chord, so the disc meets the limb without a seam or a colour
// step. hazeK scales the air density along the path (1 = physical); callers
// keep the disc centre clearer than real life. Outputs the path transmittance t
// and the in-scattered radiance s.
void atmAerial(vec3 P, vec3 V, vec3 L, float hazeK, float sunI, out vec3 t, out vec3 s) {
    float len = max(raySphere(P, V, ATM_RA).y, 0.0);
    float ds = len / 3.0;
    float odR = 0.0, odM = 0.0;
    vec3 sumR = vec3(0.0), sumM = vec3(0.0);
    for (int i = 0; i < 3; i++) {
        vec3 p = P + V * (len - (float(i) + 0.5) * ds);   // from the top down toward P
        float r = length(p);
        float h = max(r - ATM_RP, 0.0);
        float dR = exp(-h / ATM_HR) * ds * hazeK;
        float dM = exp(-h / ATM_HM) * ds * hazeK;
        float vR = odR + 0.5 * dR;
        float vM = odM + 0.5 * dM;
        odR += dR;
        odM += dM;
        vec3 sc = atmSunColumns(h, dot(p, L) / r);
        vec3 T = exp(-(ATM_BETA_R * (vR + sc.x) + ATM_BETA_M * ATM_MIE_EXT * (vM + sc.y))) * sc.z;
        sumR += T * dR;
        sumM += T * dM;
    }
    t = exp(-(ATM_BETA_R * odR + ATM_BETA_M * ATM_MIE_EXT * odM));
    float nu = dot(-V, L);
    s = sunI * (ATM_BETA_R * sumR * atmPhaseR(nu) + ATM_BETA_M * sumM * atmPhaseM(nu));
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
uniform float uIntensity;    // 1 - skyBlend
uniform float uExposure;     // artistic scale of the physical result
uniform float uPlanetR;      // inscribed radius of the Earth mesh (polygon silhouette)
uniform float uAirglow;      // airglow strength (0 disables)
uniform vec4 uEclipse;       // (on, moon radius ER, sun angular radius rad, _)
uniform vec3 uMoonPosW;

varying vec3 vPosW;

${COMMON}
${ATMO_MODEL}

#ifdef RAYMARCH
#ifndef STEPS
#define STEPS 8
#endif
#else
#undef STEPS
#define STEPS 4
#endif
// Samples per half chord (the integral is split at the ray's closest approach).
#define HALF_STEPS ((STEPS + 1) / 2)

const float SUN_I = ${ATMO_SUN_I.toFixed(1)};
const float AG_H = 0.0149;                   // airglow layer altitude (95 km)
const float AG_W = 0.0011;
// Tangent heights over which the far half of a grazing chord fades in (about 2.4 Mie
// scale heights). At the silhouette the shell then equals the near half, which is
// exactly what the surface's aerial perspective integrates, so the disc meets the
// limb without a bright, whiter line along the mesh edge.
const float FAR_FADE = 0.006;

float sunVisAt(vec3 p, vec3 Ls) {
    if (uEclipse.x < 0.5) return 1.0;
    vec3 m = uMoonPosW - p;
    float dm = length(m);
    return discVisible(uEclipse.z, asin(clamp(uEclipse.y / dm, 0.0, 1.0)), angleBetween(m / dm, Ls));
}

void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vPosW - ro);
    vec3 col = vec3(0.0);
    vec2 t = raySphere(ro, rd, ATM_RA);
    if (t.y > 0.0) {
        float t0 = max(t.x, 0.0);
        vec2 te = raySphere(ro, rd, uPlanetR);
        bool hitsPlanet = te.x > 0.0;
        float t1 = hitsPlanet ? min(t.y, te.x) : t.y;
        vec3 Ls = normalize(uSunDirW);
        if (t1 > t0) {
            // Split the chord at the closest approach: samples sit symmetrically around the
            // densest point, and the far half can fade in just above the surface.
            float tm = -dot(ro, rd);
            float tc = clamp(tm, t0, t1);
            float hc = length(ro + rd * tm) - ATM_RP;   // tangent height (< 0: hits the planet)
            float wFar = smoothstep(0.0, FAR_FADE, hc);
            float odR = 0.0, odM = 0.0;
            vec3 sumR = vec3(0.0), sumM = vec3(0.0);
            for (int k = 0; k < 2; k++) {
                float a = k == 0 ? t0 : tc;
                float ds = ((k == 0 ? tc : t1) - a) / float(HALF_STEPS);
                if (ds <= 0.0) continue;
                float w = k == 0 ? 1.0 : wFar;
                for (int i = 0; i < HALF_STEPS; i++) {
                    vec3 p = ro + rd * (a + (float(i) + 0.5) * ds);
                    float r = length(p);
                    float h = max(r - ATM_RP, 0.0);
                    float dR = exp(-h / ATM_HR) * ds;
                    float dM = exp(-h / ATM_HM) * ds;
                    // Half of this segment lies between the sample and the camera.
                    float vR = odR + 0.5 * dR;
                    float vM = odM + 0.5 * dM;
                    odR += dR;
                    odM += dM;
                    vec3 sc = atmSunColumns(h, dot(p, Ls) / r);
                    if (sc.z <= 0.0) continue;
                    vec3 T = exp(-(ATM_BETA_R * (vR + sc.x) + ATM_BETA_M * ATM_MIE_EXT * (vM + sc.y)));
                    sumR += T * (dR * sc.z * w);
                    sumM += T * (dM * sc.z * w);
                }
            }
            float nu = dot(rd, Ls);
            col = SUN_I * (ATM_BETA_R * sumR * atmPhaseR(nu) + ATM_BETA_M * sumM * atmPhaseM(nu));
            col *= sunVisAt(ro + rd * (0.5 * (t0 + t1)), Ls);
            // Soft-cap the aureole so a coarse estimate can never blow the bloom out.
            float peak = max(col.r, max(col.g, col.b));
            float pk = max(peak, 12.0);   // keeps the unselected branch finite (it was log(0) / 0)
            col *= peak > 12.0 ? (12.0 + log(pk / 12.0) * 4.0) / pk : 1.0;
        }
        // Airglow: thin emission shell, visible edge-on above the night limb.
        float b = dot(ro, rd);
        if (!hitsPlanet && b < 0.0 && uAirglow > 0.0) {
            vec3 q = ro - b * rd;               // closest approach to the centre
            float hq = length(q) - ATM_RP;
            float muQ = dot(normalize(q), Ls);
            float g = exp(-(hq - AG_H) * (hq - AG_H) / (AG_W * AG_W));
            col += vec3(0.30, 1.0, 0.50) * g * (1.0 - smoothstep(-0.25, -0.05, muQ)) * uAirglow;
        }
    }
    gl_FragColor = vec4(col * (uIntensity * uExposure), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/** Atmosphere ShaderMaterial sources. */
export const ATMOSPHERE_SHADER = { vertex, fragment };
export { vertex, fragment };
