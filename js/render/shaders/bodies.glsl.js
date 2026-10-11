/**
 * GLSL for the Sun, Moon, planet glyphs, selection reticle and lens flare (G5, SPEC E.5).
 * Every fragment shader ends with the tonemapping/colorspace includes (SPEC R6).
 */
import { INFINITY_VERT_CHUNK } from './sky.glsl.js';

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

/** Limb-darkened HDR core (at least a few px wide) plus a two-scale glow that fades at the quad edge. */
export const DISC_FRAG = /* glsl */`
uniform float uTanR;
uniform float uCoreR;
uniform float uEdge;
uniform vec3 uCoreColor;
uniform vec3 uGlowColor;
uniform float uGlowScale;
uniform float uGlowGain;
varying vec2 vUv;
void main() {
    float q = length(vUv);
    if (q >= 1.0) discard;
    float r = q * uTanR;
    float x = clamp(r / uCoreR, 0.0, 1.0);
    float limb = 1.0 - 0.6 * (1.0 - sqrt(1.0 - x * x));
    float disc = 1.0 - smoothstep(uCoreR - uEdge, uCoreR + uEdge, r);
    float glow = uGlowGain * (exp(-r / uGlowScale) + 0.12 * exp(-r / (4.0 * uGlowScale)));
    glow *= 1.0 - smoothstep(0.65, 1.0, q);
    gl_FragColor = vec4(uCoreColor * (disc * limb) + uGlowColor * glow, 1.0);
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

/** Moon (true scale, IAU orientation): standard mesh transform; world normal and position out. */
export const MOON_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vNw;
varying vec3 vPw;
void main() {
    vUv = uv;
    vNw = normalize(mat3(modelMatrix) * normal);
    vec4 pw = modelMatrix * vec4(position, 1.0);
    vPw = pw.xyz;
    gl_Position = projectionMatrix * viewMatrix * pw;
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
varying vec2 vUv;
varying vec3 vNw;
varying vec3 vPw;
const float SUN_R = 0.0046542;
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
    float vis = discVisibleG5(SUN_R, er, sep);
    if (vis < 1.0) {
        float umbra = er - SUN_R;
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

/** @see FLARE_VERT */
export const FLARE_FRAG = /* glsl */`
uniform sampler2D uFlare0;
uniform sampler2D uFlare3;
uniform vec3 uTint;
uniform float uIntensity;
uniform float uGhosts;
varying vec2 vUv;
varying float vIdx;
varying float vTint;
vec3 ghostHue(float k) {
    // Anti-reflection coatings tint ghosts in clean, saturated hues (no muddy greys):
    // green, sky blue, magenta and amber.
    if (k < 1.5) return vec3(0.45, 1.0, 0.55);
    if (k < 2.5) return vec3(0.40, 0.70, 1.0);
    if (k < 3.5) return vec3(1.0, 0.45, 0.90);
    return vec3(1.0, 0.70, 0.35);
}
void main() {
    vec3 c;
    float r = length(vUv * 2.0 - 1.0);
    // Both textures are mipmapped: sample them outside the varying-dependent branch.
    vec3 flare0 = texture2D(uFlare0, vUv).rgb;
    vec3 flare3 = texture2D(uFlare3, vUv).rgb;
    if (vIdx < 0.5) {
        // lensflare0's wide halo reaches the texture edge: a radial window (not the square quad)
        // ends it, squared so the halo stays tight around the starburst.
        float win = 1.0 - smoothstep(0.25, 0.95, r);
        c = flare0 * uTint * (win * win);
    } else {
        // Soft aperture disc with a slightly brighter rim, faded out before the quad edge.
        float rim = smoothstep(0.62, 0.80, r) * (1.0 - smoothstep(0.80, 0.94, r));
        c = (flare3 + 0.009 * rim) * uTint * ghostHue(vTint) * 0.4 * uGhosts;
        c *= 1.0 - smoothstep(0.84, 0.98, r);
    }
    gl_FragColor = vec4(c * uIntensity, 1.0);
    ${TONE}
}
`;
