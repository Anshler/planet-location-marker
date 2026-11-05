/**
 * The planet impostor (render/planets.js medallions; reusable at true scale, e.g. a telescope zoom
 * in sky view). One fragment function, `planetShade`, ray-traces a body on a screen quad:
 *
 *   vec4 planetShade(vec2 p, float aa, float kind, vec3 pole, vec3 prime, vec3 light, float oblate)
 *
 * `p` is the fragment's position on the drawing in units of the body's equatorial radius, in the
 * sky-plane frame of astro/disc.js (+x right, +y up, +z toward the viewer); `aa` is one device
 * pixel in the same units; `pole`, `prime` (prime meridian) and `light` (toward the Sun) are unit
 * vectors in that frame (astro/disc.js discView, i.e. the snapshot's poleS/primeS/lightS through
 * discFrame); `kind` is a PLANET_KIND; `oblate` the flattening (astro/disc.js SHAPES). It returns
 * straight linear RGB and a coverage alpha. Orthographic, like any planet seen from the Earth.
 *
 * What is physical: the oblate spheroid (Jupiter 0.065, Saturn 0.098) along the IAU pole, the
 * phase and terminator from the true Sun direction (Venus's crescent, Mars's gibbous disc),
 * Saturn's rings by ray–plane intersection at the true opening with their radial structure, the
 * globe's shadow on the rings and the rings' shadow on the globe, the Galilean moons (uPlMoon) and
 * their shadows on Jupiter (uPlShadow), Mars's central meridian. What is schematic: Jupiter's and
 * Saturn's belt colours and turbulence, the Great Red Spot's System II longitude (uPlGrsLon,
 * astro/disc.js grsLongitudeDeg), Mars's albedo (astro/disc.js MARS_SPOTS: a dozen Gaussian areas
 * and fixed polar caps),
 * Mercury's mottling, and the tints of Venus, Uranus and Neptune.
 *
 * Uniforms (create them with {@link planetUniforms}): uPlDetail (0 low: flat colours, no noise;
 * 1: bands, maps, turbulence, the GRS; 2 max: one more noise octave), uPlGrsLon, uPlMoon[4],
 * uPlShadow[4], uPlDotPx. Every domain-sensitive call is guarded (test/render.shaders.test.mjs).
 *
 * @module render/shaders/planets
 */
import { FINITE_CHUNK } from './common.glsl.js';
import { INFINITY_VERT_CHUNK } from './sky.glsl.js';
import { MARS_SPOTS, SATURN_RINGS, grsLongitudeDeg } from '../../astro/disc.js';

export { grsLongitudeDeg };

/** Shader kind per planet id (the instance order of render/planets.js). */
export const PLANET_KIND = Object.freeze({ mercury: 0, venus: 1, mars: 2, jupiter: 3, saturn: 4, uranus: 5, neptune: 6 });

const f = (x) => x.toFixed(5);
// Ring radii as GLSL float literals (astro/disc.js SATURN_RINGS; ringAt mirrors plRing).
const R = SATURN_RINGS.map((z) => z.map((x) => x.toFixed(3)));
const MARS_GLSL = MARS_SPOTS.map(([lon, lat, r, k]) => {
    const a = lon * Math.PI / 180, b = lat * Math.PI / 180, s = r * Math.PI / 180;
    return `vec4(${f(Math.cos(b) * Math.cos(a))}, ${f(Math.cos(b) * Math.sin(a))}, ${f(Math.sin(b))}, ${f(1 / (2 * s * s))})`;
}).join(',\n    ');
const MARS_K = MARS_SPOTS.map(([, , , k]) => f(k)).join(', ');

/**
 * Fresh uniforms for {@link PLANET_CHUNK} (merge them into a ShaderMaterial's uniforms). `uPlMoon`
 * xyzw: drawn position (x, y; equatorial radii), shown (1/0), true radius; `uPlShadow` the same
 * for each moon's shadow on the disc; `uPlDotPx`: the smallest moon dot, device px.
 * @param {typeof import('three')} THREE
 */
export function planetUniforms(THREE) {
    const v4 = () => [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, 0));
    return {
        uPlDetail: { value: 1 },
        uPlGrsLon: { value: 0 },
        uPlMoon: { value: v4() },
        uPlShadow: { value: v4() },
        uPlDotPx: { value: 1.4 },
    };
}

/** The shared impostor functions (see the module docs). */
export const PLANET_CHUNK = /* glsl */`
uniform float uPlDetail;
uniform float uPlGrsLon;
uniform vec4 uPlMoon[4];
uniform vec4 uPlShadow[4];
uniform float uPlDotPx;
const vec4 PL_MARS_SPOT[${MARS_SPOTS.length}] = vec4[${MARS_SPOTS.length}](
    ${MARS_GLSL});
const float PL_MARS_K[${MARS_SPOTS.length}] = float[${MARS_SPOTS.length}](${MARS_K});

float plHash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
float plNoise(vec2 q) {
    vec2 i = floor(q), u = fract(q);
    u = u * u * (3.0 - 2.0 * u);
    return mix(mix(plHash(i), plHash(i + vec2(1.0, 0.0)), u.x), mix(plHash(i + vec2(0.0, 1.0)), plHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float plBand(float x, float a, float b, float w) { return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }
bool plIs(float kind, float k) { return abs(kind - k) < 0.5; }

// Saturn's rings: (optical depth, albedo) at a radius (astro/disc.js SATURN_RINGS).
vec2 plRing(float r) {
    if (r < ${R[0][0]} || r > ${R[3][1]}) return vec2(0.0);
    if (r < ${R[0][1]}) return vec2(${R[0][2]}, ${R[0][3]});
    if (r < ${R[1][1]}) return vec2(mix(1.4, ${R[1][2]}, smoothstep(1.55, 1.75, r)), ${R[1][3]});
    if (r < ${R[2][1]}) return vec2(${R[2][2]}, ${R[2][3]});
    return vec2(r > 2.212 && r < 2.218 ? 0.05 : ${R[3][2]}, ${R[3][3]});
}

vec3 plJupiter(float lat, float lon) {
    float t = lat;
    if (uPlDetail > 0.5) {
        t += 1.8 * (plNoise(vec2(lon * 0.08, lat * 0.32)) - 0.5);
        if (uPlDetail > 1.5) t += 0.7 * (plNoise(vec2(lon * 0.3, lat * 1.2)) - 0.5);
    }
    vec3 zone = vec3(0.93, 0.88, 0.78), belt = vec3(0.60, 0.44, 0.32), tanc = vec3(0.76, 0.65, 0.53);
    vec3 c = zone;
    c = mix(c, belt, plBand(t, 7.0, 18.0, 1.6));
    c = mix(c, belt, plBand(t, -20.0, -7.0, 1.6));
    c = mix(c, tanc, plBand(t, 24.0, 31.0, 1.6));
    c = mix(c, tanc, plBand(t, -34.0, -27.0, 1.6));
    c = mix(c, tanc * 0.97, plBand(abs(t), 37.0, 44.0, 2.0));
    c = mix(c, vec3(0.62, 0.60, 0.58), smoothstep(46.0, 62.0, abs(t)));
    if (uPlDetail > 0.5) {
        float dl = mod(lon - uPlGrsLon + 540.0, 360.0) - 180.0;
        float e = (dl / 7.5) * (dl / 7.5) + ((lat + 22.4) / 4.6) * ((lat + 22.4) / 4.6);
        c = mix(c, vec3(0.82, 0.48, 0.34), 1.0 - smoothstep(0.55, 1.0, e));
    }
    return c;
}

vec3 plSaturn(float lat, float lon) {
    float t = lat;
    if (uPlDetail > 0.5) t += 0.8 * (plNoise(vec2(lon * 0.05, lat * 0.25)) - 0.5);
    vec3 c = vec3(0.90, 0.82, 0.62);
    c = mix(c, vec3(0.80, 0.69, 0.49), plBand(abs(t), 11.0, 22.0, 2.5));
    c = mix(c, vec3(0.86, 0.77, 0.58), 0.6 * plBand(abs(t), 28.0, 40.0, 3.0));
    c = mix(c, vec3(0.62, 0.66, 0.66), smoothstep(56.0, 74.0, abs(t)));
    return c;
}

vec3 plMars(vec3 nb, float lat) {
    vec3 c = vec3(0.78, 0.43, 0.24);
    if (uPlDetail > 0.5) {
        float dark = 0.0, bright = 0.0;
        for (int k = 0; k < ${MARS_SPOTS.length}; k++) {
            float w = exp((dot(nb, PL_MARS_SPOT[k].xyz) - 1.0) * PL_MARS_SPOT[k].w);
            if (PL_MARS_K[k] > 0.0) dark = max(dark, PL_MARS_K[k] * w);
            else bright = max(bright, -PL_MARS_K[k] * w);
        }
        if (uPlDetail > 1.5) dark *= 0.85 + 0.3 * plNoise(nb.xy * 9.0 + nb.z * 5.0);
        c = mix(c, vec3(0.40, 0.25, 0.17), clamp(dark, 0.0, 0.85));
        c = mix(c, vec3(0.92, 0.66, 0.46), clamp(bright, 0.0, 0.6));
    }
    float cap = smoothstep(71.0, 77.0, lat) + smoothstep(73.0, 80.0, -lat);
    return mix(c, vec3(0.96, 0.95, 0.94), clamp(cap, 0.0, 1.0));
}

vec3 plAlbedo(float kind, vec3 nb, float lat, float lon) {
    if (plIs(kind, 0.0)) {
        float m = uPlDetail > 0.5 ? 0.86 + 0.28 * plNoise(vec2(lon, lat) * 0.12) : 1.0;
        return vec3(0.62, 0.58, 0.55) * m;
    }
    if (plIs(kind, 1.0)) return vec3(1.0, 0.96, 0.86);
    if (plIs(kind, 2.0)) return plMars(nb, lat);
    if (plIs(kind, 3.0)) return plJupiter(lat, lon);
    if (plIs(kind, 4.0)) return plSaturn(lat, lon);
    if (plIs(kind, 5.0)) return vec3(0.45, 0.78, 0.86) * (1.0 + 0.08 * smoothstep(40.0, 80.0, lat));
    return vec3(0.30, 0.45, 0.95) * (1.0 - 0.06 * plBand(lat, -30.0, -18.0, 3.0));
}

// Visible surface of the spheroid |x|² + kf·(x·pole)² = 1 along the view ray through p:
// returns z (toward the viewer) and, in g, D/4A (> 0 on the disc, ≈ 1 − r² for a sphere).
float plSpheroid(vec2 p, vec3 pole, float kf, out float g) {
    float a = p.x * pole.x + p.y * pole.y;
    float A = 1.0 + kf * pole.z * pole.z;
    float B = 2.0 * kf * a * pole.z;
    float C = dot(p, p) + kf * a * a - 1.0;
    float D = B * B - 4.0 * A * C;
    g = D / (4.0 * A);
    return (-B + sqrt(max(D, 0.0))) / (2.0 * A);
}

vec4 planetShade(vec2 p, float aa, float kind, vec3 pole, vec3 prime, vec3 light, float oblate) {
    float kf = 1.0 / ((1.0 - oblate) * (1.0 - oblate)) - 1.0;
    float stretch = 1.0 / (1.0 - oblate);
    bool saturn = plIs(kind, 4.0);
    bool jupiter = plIs(kind, 3.0);
    float g;
    float zg = plSpheroid(p, pole, kf, g);
    float aG = clamp(0.5 + g / (2.0 * max(length(p), 0.5) * aa), 0.0, 1.0);
    vec3 colG = vec3(0.0);
    if (g > -4.0 * aa) {
        vec3 x = vec3(p, zg);
        vec3 n = normalize(x + kf * dot(x, pole) * pole);
        vec3 east = cross(pole, prime);
        vec3 nb = vec3(dot(n, prime), dot(n, east), dot(n, pole));
        float lat = degrees(asin(clamp(nb.z, -1.0, 1.0)));
        float lon = degrees(atan(nb.y, nb.x + 1e-7));
        float mu0 = dot(n, light);
        float mu = max(n.z, 0.0);
        vec3 alb = plAlbedo(kind, nb, lat, lon);
        float lit;
        if (plIs(kind, 0.0)) lit = 2.0 * max(mu0, 0.0) / (max(mu0, 0.0) + mu + 1e-3);     // Lommel–Seeliger
        else if (plIs(kind, 1.0)) lit = pow(max(mu0, 0.0), 0.75);                         // Venus: soft cloud terminator
        else lit = max(mu0, 0.0) * mix(0.62, 1.0, mu);                                    // limb-darkened Lambert
        // The terminator is a line on the sphere: soften it by about a pixel.
        lit *= smoothstep(-aa, aa, mu0);
        if (saturn && abs(dot(light, pole)) > 1e-4) {
            // The rings' shadow on the globe.
            float s = -dot(x, pole) / dot(light, pole);
            if (s > 0.0) {
                vec2 rt = plRing(length(x + s * light));
                lit *= exp(-rt.x / max(abs(dot(light, pole)), 0.05));
            }
        }
        if (jupiter) {
            for (int k = 0; k < 4; k++) {
                vec4 sh = uPlShadow[k];
                if (sh.z < 0.5) continue;
                float r = max(sh.w, 0.8 * uPlDotPx * aa);
                lit *= 1.0 - 0.92 * (1.0 - smoothstep(r - aa, r + aa, length(p - sh.xy)));
            }
        }
        colG = alb * (lit + 0.006);
    }
    vec3 col = colG;
    float alpha = aG;
    if (saturn) {
        // Rings: the plane x·pole = 0, opened to at least a pixel so an edge-on ring stays a line.
        float pz = pole.z;
        float pzc = (pz < 0.0 ? -1.0 : 1.0) * max(abs(pz), aa);
        float zr = -(p.x * pole.x + p.y * pole.y) / pzc;
        vec3 q = vec3(p, zr);
        vec2 rt = plRing(length(q));
        if (rt.x > 0.0) {
            float slant = max(abs(pz), 0.02);
            float aR = (1.0 - exp(-rt.x / slant)) * abs(pz) / max(abs(pz), aa);
            float lp = dot(light, pole);
            float I;
            if (lp * pz > 0.0) I = rt.y * (0.55 + 0.45 * sqrt(abs(lp)));       // the sunlit face
            else I = rt.y * 0.9 * exp(-rt.x);                                    // lit from behind
            // The globe's shadow on the rings: does the ray toward the Sun hit the spheroid?
            vec3 Ls = light + (stretch - 1.0) * lp * pole;
            float A = dot(Ls, Ls), B = 2.0 * dot(q, Ls), C = dot(q, q) - 1.0;
            float disc = B * B - 4.0 * A * C;
            if (B < 0.0) I *= 1.0 - smoothstep(-0.02, 0.02, disc / (4.0 * A));
            vec3 colR = vec3(0.92, 0.86, 0.72) * I + vec3(0.92, 0.86, 0.72) * 0.01;
            bool front = g <= 0.0 || zr > zg;
            if (front) {
                col = colR * aR + colG * aG * (1.0 - aR);
                alpha = aR + aG * (1.0 - aR);
            } else {
                col = colG * aG + colR * aR * (1.0 - aG);
                alpha = aG + aR * (1.0 - aG);
            }
            col /= max(alpha, 1e-4);
        }
    }
    if (jupiter) {
        for (int k = 0; k < 4; k++) {
            vec4 m = uPlMoon[k];
            if (m.z < 0.5) continue;
            float r = max(m.w, uPlDotPx * aa);
            float d = length(p - m.xy);
            // Off the disc a moon gets a thin dark rim, so it reads over a bright beam behind it.
            if (dot(m.xy, m.xy) > 1.0) {
                float rh = r + 0.8 * uPlDotPx * aa;
                float aH = 0.75 * (1.0 - smoothstep(rh - aa, rh + aa, d));
                float nh = aH + alpha * (1.0 - aH);
                col = (vec3(0.01, 0.015, 0.03) * aH + col * alpha * (1.0 - aH)) / max(nh, 1e-4);
                alpha = nh;
            }
            float aM = 1.0 - smoothstep(r - aa, r + aa, d);
            vec3 cm = vec3(0.95, 0.91, 0.82) * 0.9;
            float na = aM + alpha * (1.0 - aM);
            col = (cm * aM + col * alpha * (1.0 - aM)) / max(na, 1e-4);
            alpha = na;
        }
    }
    return vec4(col, alpha);
}
`;

/**
 * Medallion quad: an instanced, screen-aligned square centred on a world point, `iShape.w` device
 * px per equatorial radius and `iShape.z` radii of half-extent. Frame vectors are per instance.
 */
export const MEDALLION_VERT = /* glsl */`
uniform vec2 uViewport;
attribute vec3 iCenter;
attribute vec3 iPole;
attribute vec3 iPrime;
attribute vec3 iLight;
attribute vec4 iShape;
attribute float iAlpha;
varying vec2 vP;
varying float vAa;
varying vec3 vPole;
varying vec3 vPrime;
varying vec3 vLight;
varying vec3 vShape;
void main() {
    vec4 c = projectionMatrix * viewMatrix * vec4(iCenter, 1.0);
    float ext = iShape.z;
    float rpx = max(iShape.w, 0.5);
    c.xy += position.xy * ext * rpx * 2.0 / uViewport * c.w;
    c.z = min(c.z, c.w * 0.999999);
    gl_Position = iAlpha > 0.002 ? c : vec4(2.0, 2.0, 2.0, 1.0);
    vP = position.xy * ext;
    vAa = 1.0 / rpx;
    vPole = iPole;
    vPrime = iPrime;
    vLight = iLight;
    vShape = vec3(iShape.x, iShape.y, iAlpha);
}
`;

export const MEDALLION_FRAG = /* glsl */`
uniform float uGain;
varying vec2 vP;
varying float vAa;
varying vec3 vPole;
varying vec3 vPrime;
varying vec3 vLight;
varying vec3 vShape;
${FINITE_CHUNK}
${PLANET_CHUNK}
void main() {
    vec4 c = planetShade(vP, vAa, vShape.x, normalize(vPole), normalize(vPrime), normalize(vLight), vShape.y);
    float a = c.a * vShape.z;
    if (a < 0.004) discard;
    gl_FragColor = vec4(pcFinite(c.rgb * uGain), a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/**
 * Sky-view telescope quads (render/planets.js): instanced and screen-aligned on a direction at
 * infinity (infinityClip, so refraction lifts them exactly like the glyphs), `iShape.w` device px
 * per equatorial radius and `iShape.z` radii of half-extent; `iTint` is the linear-light gain
 * (exposure and extinction) and the cross-fade. Kind 7 is a Galilean moon: a small, gently
 * limb-darkened disc, never under uPlDotPx across.
 */
export const SCOPE_VERT = /* glsl */`
uniform vec2 uViewport;
attribute vec3 iDir;
attribute vec3 iPole;
attribute vec3 iPrime;
attribute vec3 iLight;
attribute vec4 iShape;
attribute vec4 iTint;
varying vec2 vP;
varying float vAa;
varying vec3 vPole;
varying vec3 vPrime;
varying vec3 vLight;
varying vec2 vShape;
varying vec4 vTint;
${INFINITY_VERT_CHUNK}
void main() {
    vec4 c = infinityClip(normalize(iDir));
    float rpx = max(iShape.w, 1e-4);
    c.xy += position.xy * iShape.z * rpx * 2.0 / uViewport * c.w;
    gl_Position = iTint.a > 0.002 ? c : vec4(2.0, 2.0, 2.0, 1.0);
    vP = position.xy * iShape.z;
    vAa = 1.0 / rpx;
    vPole = iPole;
    vPrime = iPrime;
    vLight = iLight;
    vShape = iShape.xy;
    vTint = iTint;
}
`;

export const SCOPE_FRAG = /* glsl */`
varying vec2 vP;
varying float vAa;
varying vec3 vPole;
varying vec3 vPrime;
varying vec3 vLight;
varying vec2 vShape;
varying vec4 vTint;
${FINITE_CHUNK}
${PLANET_CHUNK}
void main() {
    vec4 c;
    if (vShape.x > 6.5) {
        float r = max(1.0, 0.5 * uPlDotPx * vAa);
        float d = length(vP);
        float mu = sqrt(max(1.0 - min(d * d / (r * r), 1.0), 0.0));
        c = vec4(vec3(0.95, 0.91, 0.82) * (0.62 + 0.38 * mu), 1.0 - smoothstep(r - vAa, r + vAa, d));
    } else {
        c = planetShade(vP, vAa, vShape.x, normalize(vPole), normalize(vPrime), normalize(vLight), vShape.y);
    }
    float a = c.a * vTint.a;
    if (a < 0.003) discard;
    gl_FragColor = vec4(pcFinite(c.rgb * vTint.rgb), a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;
