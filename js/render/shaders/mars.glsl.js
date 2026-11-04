/**
 * GLSL for the Mars sky view (render/mars-sky.js; ROADMAP stand-on-mars). Loaded only when the
 * observer stands on Mars. Every fragment ends with the tonemapping/colorspace includes (SPEC R6).
 *
 * The sky is illustrative, tuned by eye to rover imagery (Pathfinder, Spirit, Curiosity,
 * Perseverance Mastcam-Z), not a radiative-transfer model: a thin CO₂ atmosphere carries a dust
 * load of optical depth ~0.5–1, whose micron-sized grains absorb blue and scatter red, so the day
 * sky is butterscotch, brightening toward the horizon (a longer dust column) and toward the Sun (a
 * broad forward lobe). The same grains forward-scatter blue light into a narrow lobe a few degrees
 * wide (their size is close to the wavelength), so around a low Sun the sky turns blue, and after
 * sunset the blue aureole lingers over the Sun's azimuth while the rest of the dome goes brown-grey.
 * Dust aloft keeps twilight going for about two hours (the dome is still lit at −15°).
 */
import { INFINITY_VERT_CHUNK } from './sky.glsl.js';
import { FINITE_CHUNK } from './common.glsl.js';

/** The dome: a sphere at infinity (no translation, depth just inside the far plane). */
export const MARS_SKY_VERT = /* glsl */`
varying vec3 vDir;
${INFINITY_VERT_CHUNK}
void main() {
    vDir = normalize(mat3(modelMatrix) * position);
    gl_Position = infinityClip(vDir);
}
`;

/**
 * uSunDir: the Sun as drawn; uDust: the dust load (1 = a clear-season τ ≈ 0.6); uDisplay: the
 * sky view's display exposure (sky.js skyViewExposure); uFade: the view blend.
 */
export const MARS_SKY_FRAG = /* glsl */`
uniform vec3 uUp;
uniform vec3 uSunDir;
uniform float uSunAltDeg;
uniform float uDisplay;
uniform float uFade;
uniform float uDust;
varying vec3 vDir;
${FINITE_CHUNK}
void main() {
    vec3 d = normalize(vDir);
    float h = dot(d, uUp);
    float hv = max(h, 0.0);
    float alt = uSunAltDeg;
    float cosT = clamp(dot(d, uSunDir), -1.0, 1.0);
    float theta = acos(clamp(cosT, -1.0, 1.0));
    // Daylight on the dust, falling through sunset; the long dusty twilight below it.
    float day = smoothstep(-3.0, 10.0, alt);
    float tw = smoothstep(-22.0, -1.0, alt) * (1.0 - day);
    float lit = mix(0.18, 1.0, smoothstep(0.0, 35.0, alt));
    // The dust column toward the view: the sky brightens and yellows toward the horizon.
    float X = 1.0 / (hv + 0.12);
    float col = 1.0 - exp(-0.30 * X * uDust);
    vec3 zenith = vec3(0.47, 0.29, 0.17);
    vec3 butter = vec3(0.92, 0.61, 0.33);
    vec3 base = mix(zenith, butter, col);
    // A broad forward lobe of the large grains (Henyey–Greenstein, g = 0.65), warm.
    float g = 0.65;
    float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5);
    vec3 warm = vec3(1.0, 0.78, 0.55) * hg * 0.05;
    // The narrow blue aureole, stronger as the Sun's light crosses more dust.
    float sunX = 1.0 / (max(sin(radians(alt)), 0.0) + 0.08);
    float aGain = 0.05 + 0.035 * min(sunX, 10.0);
    float aure = exp(-theta / radians(5.0)) + 0.45 * exp(-theta / radians(16.0));
    vec3 blue = vec3(0.16, 0.40, 1.0);
    vec3 dayCol = (base * (0.85 + warm * 4.0) * lit + blue * aure * aGain) * day;
    // Twilight: the blue glow over the set Sun, low in the sky, fading as it sinks; a dim brown dome.
    vec3 sunH = uSunDir - uUp * dot(uSunDir, uUp);
    vec3 dH = d - uUp * h;
    float sl = length(sunH), dl = length(dH);
    float cAz = (sl > 1e-5 && dl > 1e-5) ? dot(dH / dl, sunH / sl) : 0.0;
    float depth = exp(min(alt, 0.0) / 6.0);
    float lowB = exp(-hv / 0.22);
    float az = pow(clamp(0.5 + 0.5 * cAz, 0.0, 1.0), 5.0);
    vec3 twCol = blue * (aure * 0.9 + az * lowB * 0.35) * depth
        + vec3(0.16, 0.11, 0.08) * (0.25 + 0.75 * lowB) * depth * 0.35;
    vec3 c = dayCol + twCol * tw + vec3(0.0005, 0.00045, 0.0004);
    // A soft highlight knee (asymptote ~0.9): only the Sun itself should bloom.
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k0 = 0.5, kr = 0.4;
    c = l > k0 ? c * ((k0 + (l - k0) / (1.0 + (l - k0) / kr)) / l) : c;
    gl_FragColor = vec4(pcFinite(c * uDisplay * uFade), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/**
 * Phobos and Deimos: a camera-facing quad at a finite distance (so the Sun and the stars behind it
 * fail the depth test: a transit is a dark fleck on the Sun), shaded as a dark Lambert sphere lit
 * along uLight. Additive colour: the airglow and dust light between us and the moon stay in front.
 * aCorner: the quad corner (±1, ±1).
 */
export const MOONLET_VERT = /* glsl */`
uniform vec3 uCenter;     // world position of the moon's centre (camera + dir · distance)
uniform float uRadius;    // its drawn radius, world units
varying vec2 vUv;
void main() {
    vUv = position.xy;
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 p = uCenter + (right * position.x + up * position.y) * uRadius;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const MOONLET_FRAG = /* glsl */`
uniform vec3 uLightV;     // toward the Sun, in view space
uniform vec3 uColor;      // albedo × sunlight × exposure
uniform float uEdge;      // anti-aliasing width, in disc radii
varying vec2 vUv;
${FINITE_CHUNK}
void main() {
    float r2 = dot(vUv, vUv);
    if (r2 > 1.0) discard;
    vec3 n = vec3(vUv, sqrt(max(1.0 - r2, 0.0)));
    float lam = max(dot(n, normalize(uLightV)), 0.0);
    float edge = 1.0 - smoothstep(1.0 - uEdge, 1.0, sqrt(r2));
    vec3 c = uColor * (lam * 0.92 + 0.08 * lam * lam) * edge;
    gl_FragColor = vec4(pcFinite(c), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/**
 * The light from home: a screen-width ribbon from the ground a little ahead of the observer toward
 * the Earth (at infinity along uDir), with pulses running down it at the speed of the story (light
 * travelling from the Earth to Mars). aT.x is the distance parameter 0…1, aT.y the side (−1, 1).
 */
export const HOMEBEAM_VERT = /* glsl */`
attribute vec2 aT;
uniform vec3 uOrigin;
uniform vec3 uDir;
uniform float uLen;
uniform vec2 uViewport;
uniform float uWidthPx;
varying float vT;
varying float vSide;
vec4 at(float t) { return projectionMatrix * viewMatrix * vec4(uOrigin + uDir * (uLen * t * t * t), 1.0); }
void main() {
    float t = aT.x;
    vec4 a = at(t);
    vec4 b = at(min(t + 0.01, 1.0));
    vec4 c = at(max(t - 0.01, 0.0));
    vec2 sa = a.xy / a.w, sb = (b.w > 0.0 ? b.xy / b.w : sa), sc = (c.w > 0.0 ? c.xy / c.w : sa);
    vec2 tg = (sb - sc) * uViewport;
    float l = length(tg);
    vec2 nrm = l > 1e-6 ? vec2(-tg.y, tg.x) / l : vec2(0.0, 1.0);
    // Wider at the observer's end, a hair at the Earth.
    float w = uWidthPx * mix(1.0, 0.25, t);
    a.xy += nrm * aT.y * w / uViewport * 2.0 * a.w;
    vT = t;
    vSide = aT.y;
    gl_Position = a;
}
`;

export const HOMEBEAM_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uPhase;
uniform float uAlpha;
varying float vT;
varying float vSide;
${FINITE_CHUNK}
void main() {
    float core = exp(-vSide * vSide * 4.0);
    float ends = smoothstep(0.0, 0.08, vT) * (1.0 - smoothstep(0.82, 1.0, vT));
    float p = fract(vT * 6.0 + uPhase);
    float pulse = 0.55 + 0.45 * smoothstep(0.75, 1.0, p);
    gl_FragColor = vec4(pcFinite(uColor * core * ends * pulse * uAlpha), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;
