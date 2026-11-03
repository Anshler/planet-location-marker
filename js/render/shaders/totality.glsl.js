/**
 * GLSL for Baily's beads and the diamond ring (render/totality.js): instanced point sprites at
 * infinity, sized in device pixels. Every fragment shader ends with the tonemapping/colorspace
 * includes (SPEC R6) and scrubs its output (pcFinite).
 */
import { INFINITY_VERT_CHUNK } from './sky.glsl.js';
import { FINITE_CHUNK } from './common.glsl.js';

/** iParams: x = core sigma (device px), y = peak radiance (HDR), z = ray length (device px, 0: none), w = visible. */
export const BEAD_VERT = /* glsl */`
uniform vec2 uViewport;
attribute vec3 iDir;
attribute vec4 iParams;
varying vec2 vPx;
varying vec3 vParams;
varying float vExt;
${INFINITY_VERT_CHUNK}
void main() {
    float ext = max(iParams.x * 7.0, iParams.z) + 2.0;
    vec4 c = infinityClip(normalize(iDir));
    c.xy += position.xy * ext * 2.0 / uViewport * c.w;
    gl_Position = iParams.w > 0.5 ? c : vec4(2.0, 2.0, 2.0, 1.0);
    vPx = position.xy * ext;
    vExt = ext;
    vParams = iParams.xyz;
}
`;

/**
 * Gaussian core and a soft halo (bloom turns them into the diamond ring on medium/high). With rays
 * set, six thin analytic rays: the low tier has neither bloom nor the lens flare's starburst.
 */
export const BEAD_FRAG = /* glsl */`
uniform vec3 uTint;
uniform float uDpr;
uniform float uRayGain;
varying vec2 vPx;
varying vec3 vParams;
varying float vExt;
${FINITE_CHUNK}
void main() {
    float s = vParams.x;
    vec2 p = clamp(vPx, vec2(-vExt), vec2(vExt));
    float r2 = dot(p, p);
    float r = sqrt(r2);
    float core = exp(-0.5 * r2 / (s * s));
    float halo = 0.05 * exp(-r / (2.5 * s));
    float rays = 0.0;
    if (vParams.z > 0.0) {
        float w = 0.55 * uDpr;
        float L = 0.35 * vParams.z;
        vec2 a = p;
        vec2 b = mat2(0.5, 0.8660254, -0.8660254, 0.5) * p;
        vec2 c = mat2(0.5, -0.8660254, 0.8660254, 0.5) * p;
        rays = exp(-abs(a.y) / w - abs(a.x) / L) + exp(-abs(b.y) / w - abs(b.x) / L) + exp(-abs(c.y) / w - abs(c.x) / L);
        rays *= uRayGain * min(3.0, 0.1 * vParams.y);
    }
    vec3 col = uTint * (vParams.y * (core + halo) + rays);
    col *= 1.0 - smoothstep(0.6, 1.0, r / vExt);
    gl_FragColor = vec4(pcFinite(col), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;
