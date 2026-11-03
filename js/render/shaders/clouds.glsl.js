/**
 * Cloud shell shader (SPEC §E.2, shell r = 1.006, alpha-blended over the Earth).
 *
 * Cloud tops are lit by sunlight filtered through the shared atmosphere model
 * at their own altitude, so after the ground terminator they glow gold, then
 * red, then go dark, with the colour sequence of a real sunset. Clouds are
 * volumes, so lighting wraps past grazing. The unlit deck is moonlit by the
 * Moon's phase over a faint floor, city lights glow through it at night,
 * slant paths near the limb read thicker, and the same aerial perspective as
 * the surface keeps clouds inside the air.
 *
 * Sculpted from the one cloud map (no extra bytes; the density is read as a height field of up to
 * CLOUD_H, a heuristic that treats thin cirrus as low cloud):
 *  - relief: central differences on mip lod + 1 (4 taps; on max that is the 8192 map, so the
 *    relief is twice as fine as high's, and on medium the 2048 one). A zero-fetch surface-gradient
 *    bump (Mikkelsen 2010) from screen derivatives was tried for medium: derivatives are per 2x2
 *    quad on most GPUs, which drew a checkerboard into the clouds;
 *  - self-shadow (CLOUD_SELF_SHADOW, high and max): 4 taps toward the Sun; taller cloud above the
 *    rising sun ray darkens the deck, so low Sun lays long shadows across lower decks;
 *  - Beer-powder albedo: thin cloud reflects less than its cover suggests (grey wisps over ocean);
 *  - a Henyey-Greenstein forward lobe (g = 0.6), soft-capped, on thin cloud: silver linings when
 *    the Sun is behind the clouds near the limb;
 *  - sub-texel erosion when magnified: 2-octave gradient noise at about 2.4x and 8.9x the texel
 *    frequency (off the texel grid, so no block mosaic), moving with the clouds, works the edges
 *    of the B-spline blobs.
 * At home distance the brc4k texels are ~10 km, so this reads as texture in the terminator band,
 * not an orbital-photo landscape. cloudAt (CLOUD_LOOKUP) is untouched, so the ground's cloud
 * shadows stay registered.
 */
import { COMMON, SURFACE_FRAG } from './common.glsl.js';
import { ATMO_MODEL } from './atmosphere.glsl.js';
import { SURFACE_VERTEX, CLOUD_LOOKUP } from './earth.glsl.js';
import { AURORA_CHUNK } from './aurora.glsl.js';

const vertex = SURFACE_VERTEX;

const fragment = /* glsl */ `
uniform sampler2D uClouds;
uniform sampler2D uNight;
uniform vec3 uSunDirW;
uniform vec3 uSunDirL;
uniform vec3 uPoleW;
uniform float uSunE;
uniform float uLightsGain;
uniform float uHazeE;
uniform float uCloudMode;
uniform float uCloudShift;
uniform float uAtmo;
uniform float uFade;
uniform vec4 uEclipse;
uniform vec3 uMoonPosW;
uniform float uMoonK;

varying vec3 vPosL;
varying vec3 vPosW;
varying vec3 vNw;

${COMMON}
${SURFACE_FRAG}
${ATMO_MODEL}
${CLOUD_LOOKUP}
${AURORA_CHUNK}

const float CLOUD_TOP = 0.006;   // shell altitude in Earth radii
const float CLOUD_H = 0.004;     // relief of a full-density cloud (ER; illustrative)
const float MAX_SLOPE = 1.5;     // the 8-bit maps are noisy: relief slopes are clamped

// Density at an explicit lod (relief and shadow taps; no B-spline), same curve as cloudAt.
float cloudLod(sampler2D tex, vec2 st, float lod) {
    vec4 t = textureLod(tex, st, lod);
    return cloudDensity(uCloudMode < 1.5 ? t.r : t.b);
}

// Gradient noise in about ±0.5, periodic in x with period w (whole cells: the map wraps at the
// dateline). Value noise drew its lattice as squares.
vec2 cloudGrad(vec2 c) {
    float a = 6.2831853 * hash12(c);
    return vec2(cos(a), sin(a));
}
float cloudNoise(vec2 q, float w) {
    vec2 i = floor(q);
    vec2 f = q - i;
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float x0 = mod(i.x, w), x1 = mod(i.x + 1.0, w);
    float a = dot(cloudGrad(vec2(x0, i.y)), f), b = dot(cloudGrad(vec2(x1, i.y)), f - vec2(1.0, 0.0));
    float c = dot(cloudGrad(vec2(x0, i.y + 1.0)), f - vec2(0.0, 1.0));
    float d = dot(cloudGrad(vec2(x1, i.y + 1.0)), f - vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
    vec3 pl = normalize(vPosL);
    vec3 Ng = normalize(vNw);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 L = normalize(uSunDirW);
    float mu = dot(Ng, L);
    vec2 uvRaw = localDirToUv(pl);
    vec2 uv = seamlessUv(uvRaw);

    float cloud = cloudAt(uClouds, uv);

    // The map's own lod (cloudAt computes it for clouds2k only).
    vec2 st = vec2(uv.x - uCloudShift, uv.y);
    vec2 csz = vec2(textureSize(uClouds, 0));
    vec2 cdx = dFdx(st) * csz, cdy = dFdy(st) * csz;
    float lod = 0.5 * log2(max(max(dot(cdx, cdx), dot(cdy, cdy)), 1e-8));
    float polar = 1.0 - smoothstep(0.84, 0.95, abs(uv.y - 0.5) * 2.0);

    // Tangent frame (world), robust at the poles.
    vec3 eW = cross(uPoleW, Ng);
    float eLen = length(eW);
    eW = eLen > 1e-5 ? eW / eLen : normalize(cross(vec3(1.0, 0.0, 0.0), Ng));
    vec3 nW = cross(Ng, eW);

    // --- relief normal from the density field ---------------------------
    vec3 Nc = Ng;
    {
        float rl = max(lod, 0.0) + 1.0;
        vec2 tx = exp2(rl) / csz;   // one texel of mip rl, in uv
        float dE = cloudLod(uClouds, st + vec2(tx.x, 0.0), rl), dW = cloudLod(uClouds, st - vec2(tx.x, 0.0), rl);
        float dN = cloudLod(uClouds, st + vec2(0.0, tx.y), rl), dS = cloudLod(uClouds, st - vec2(0.0, tx.y), rl);
        float cosLat = max(length(pl.xz), 0.05);
        // Height difference over the ground distance of two texels (Earth radii).
        vec2 grad = vec2((dE - dW) / (4.0 * PI * cosLat * tx.x), (dN - dS) / (2.0 * PI * tx.y)) * (CLOUD_H * polar);
        grad /= max(1.0, length(grad) / MAX_SLOPE);
        Nc = normalize(Ng - grad.x * eW - grad.y * nW);
    }

    // --- sub-texel erosion when magnified: crisp, noisy edges instead of blobs. Two octaves (about
    //     2.4 and 8.9 cells per texel: off the texel grid, or the lattice lines up with the blobs as
    //     a block mosaic; a whole number of cells per turn), each faded in only once its cells span
    //     2+ pixels (no salt noise). The mean thinning is (1 − cloud)-weighted as ever; the noise
    //     works the edges, 2·cloud·(1 − cloud), so thin cloud and cores stay smooth ---
    float ero = 1.0 - smoothstep(-1.5, -0.5, lod);
    float dens = cloud;
    if (ero > 0.0 && cloud > 0.0) {
        float texPx = exp2(-lod);   // pixels per texel
        float w1 = floor(csz.x * 2.37 + 0.5), w2 = floor(csz.x * 8.93 + 0.5);
        vec2 q = vec2(fract(st.x), st.y * csz.y / csz.x);
        float g = 0.6 * smoothstep(3.0, 6.0, texPx) * cloudNoise(q * w1 + vec2(0.0, 0.37), w1)
                + 0.4 * smoothstep(12.0, 24.0, texPx) * cloudNoise(q * w2 + vec2(0.0, 0.71), w2);
        float thin = 0.15 * (1.0 - cloud) + 0.6 * g * cloud * (1.0 - cloud);
        dens = mix(cloud, clamp((cloud - thin) / 0.7, 0.0, 1.0) * polar, ero);
    }

    float sunVis = 1.0;
    if (uEclipse.x > 0.5) {
        vec3 m = uMoonPosW - vPosW;
        float dm = length(m);
        sunVis = discVisible(uEclipse.z, asin(clamp(uEclipse.y / dm, 0.0, 1.0)), angleBetween(m / dm, L));
    }

    // --- self-shadow: taller cloud above the ray toward the Sun -----------
    float selfVis = 1.0;
#ifdef CLOUD_SELF_SHADOW
    if (cloud > 0.02 && mu > -0.1) {
        vec3 Ls = normalize(uSunDirL);
        float c = dot(Ls, pl);
        vec3 Lt = Ls - pl * c;
        float lt = length(Lt);
        if (lt > 1e-4) {
            Lt /= lt;
            float tanA = max(c, 0.0) / max(lt, 1e-3);   // slope of the sun ray over the deck
            float stepT = 0.0025 / max(c, 0.08);        // ground distance per tap (ER)
            float h0 = cloud * CLOUD_H;
            float rl = max(lod, 0.0) + 1.0;
            float excess = 0.0;
            for (int i = 1; i <= 4; i++) {
                float t = stepT * float(i);
                vec2 duv = localDirToUv(normalize(pl + Lt * t)) - uvRaw;
                duv.x -= floor(duv.x + 0.5);            // continuous across the dateline
                float hs = cloudLod(uClouds, st + duv, rl) * polar * CLOUD_H;
                excess += max(hs - (h0 + t * tanA), 0.0);
            }
            selfVis = exp(-1.6 * excess / CLOUD_H);
        }
    }
#endif

    // Beer-powder albedo: thin cloud reflects less than its cover (grey wisps), cores read white.
    float tau = 8.0 * dens;
    float beer = (1.0 - exp(-tau)) * (1.0 - 0.5 * exp(-2.0 * tau));

    // Forward scattering (Henyey-Greenstein, g = 0.6, relative to isotropic) on thin cloud only, so
    // backlit edges near the limb get a silver lining while face-on views are unchanged.
    float nu = dot(-V, L);
    float hg = 0.64 / pow(max(1.36 - 1.2 * nu, 1e-4), 1.5);
    float silver = max(hg - 1.0, 0.0) * 0.5 * exp(-0.35 * tau);
    silver = 2.5 * (1.0 - exp(-silver / 2.5));   // soft cap: at most 3.5x

    // Sunlit tops: white by day; gold, red, then dark as the Sun sets on them.
    vec3 sunC = atmSunTint(CLOUD_TOP, mu);
    float wrapL = pow(clamp((dot(Nc, L) + 0.25) / 1.25, 0.0, 1.0), 0.8);
    vec3 col = sunC * wrapL * uSunE * 0.9 * sunVis * selfVis * beer * (1.0 + silver);

    // Unlit deck: moonlit by the Moon's phase over a faint floor; cool and desaturated, never brown.
    float dark = 1.0 - smoothstep(-0.12, 0.0, mu);
    vec3 M = normalize(uMoonPosW - vPosW);
    float wrapM = clamp((dot(Nc, M) + 0.25) / 1.25, 0.0, 1.0);
    col += vec3(0.55, 0.75, 1.3) * (0.0035 + 0.022 * uMoonK * wrapM) * mix(0.5, 1.0, beer) * dark;

    // City light scattered up through the deck (blurred: clouds diffuse it). The blur is
    // mip 3.5 of the 4096 map: the same ground width whichever night map is bound.
    float nightW = 1.0 - smoothstep(-0.12, 0.03, mu);
    float blurLod = max(3.5 + log2(float(textureSize(uNight, 0).x) / 4096.0), 0.0);
    vec3 below = pow(textureLod(uNight, uv, blurLod).rgb, vec3(1.0, 1.1, 1.35)) * vec3(1.0, 0.8, 0.55);
    col += below * uLightsGain * nightW * 0.35;

    // Aerial perspective, as on the surface: the tops sit above part of the air,
    // so they are clearer face-on, but near the limb they sink into the same haze.
    float NoV = max(dot(Ng, V), 1e-3);
    float edge = 1.0 - NoV;
    if (uAtmo > 0.5) {
        vec3 Tv, Si;
        atmAerial(Ng, V, L, mix(0.07, 0.9, edge * edge * edge), uHazeE, Tv, Si);
        col = col * Tv + Si * sunVis;
    }

    // The aurora above the deck (the surface adds the same term, so it is unchanged by cover).
    col += auroraFace(Ng, V, L);

    // Thicker along slant paths (capped: the deck is thin).
    float a = clamp(dens * 0.95, 0.0, 0.98);
    a = 1.0 - pow(1.0 - a, clamp(0.6 / max(NoV, 0.05), 1.0, 1.8));
    // The shell sits 38 km up, so near the limb it pokes past the Earth's
    // silhouette. Clouds whose view ray misses the planet would draw a hard
    // white line above the horizon: fade them out across that band.
    vec3 rd = -V;
    float miss = length(cross(cameraPosition, rd));   // closest approach of the view ray
    float b = dot(cameraPosition, rd);
    a *= b < 0.0 ? 1.0 - smoothstep(0.9985, 1.003, miss) : 1.0;

    gl_FragColor = vec4(col, a * uFade);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/** Cloud shell ShaderMaterial sources. */
export const CLOUDS_SHADER = { vertex, fragment };
export { vertex, fragment };
