/**
 * GLSL for the solar-system zoom's orrery (render/orrery.js). Every fragment shader ends with the
 * tonemapping/colorspace includes (SPEC R6). Output is premultiplied (blend ONE,
 * ONE_MINUS_SRC_ALPHA) unless noted.
 *
 * @module render/shaders/orrery.glsl
 */

const TONE = /* glsl */`
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
`;

/**
 * Body sprites: a lit sphere (aKind 0: the Sun at the origin lights it, so planets show phases), a
 * self-lit dot (1: the Sun on the low tier, the retrograde figure's positions) or the selection
 * ring (2). aSize is the radius in CSS px; aAlpha 0 hides the sprite.
 */
export const SPRITE_VERT = /* glsl */`
uniform float uDpr;
attribute vec3 aColor;
attribute float aSize;
attribute float aKind;
attribute float aAlpha;
varying vec3 vColor;
varying vec3 vLight;
varying float vKind;
varying float vAlpha;
varying float vPx;
void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 sunV = (viewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz - mv.xyz;
    float sl = length(sunV);
    vLight = sl > 1e-12 ? sunV / sl : vec3(0.0, 0.0, 1.0);
    vPx = max(aSize * uDpr, 0.5);
    gl_PointSize = 2.0 * vPx + 3.0;
    vColor = aColor;
    vKind = aKind;
    vAlpha = aAlpha;
    gl_Position = aAlpha > 0.0 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

/** @see SPRITE_VERT */
export const SPRITE_FRAG = /* glsl */`
varying vec3 vColor;
varying vec3 vLight;
varying float vKind;
varying float vAlpha;
varying float vPx;
void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    p.y = -p.y;
    vec2 q = p * (vPx + 1.5);
    float r = length(q);
    vec3 col;
    float a;
    if (vKind > 1.5) {
        float ring = 1.0 - smoothstep(0.6, 1.3, abs(r - max(vPx - 1.2, 1.0)));
        col = vColor * ring;
        a = ring;
    } else {
        float disc = 1.0 - smoothstep(vPx - 0.7, vPx + 0.7, r);
        if (disc <= 0.0) discard;
        vec2 s = q / vPx;
        vec3 n = vec3(s, sqrt(max(0.0, 1.0 - dot(s, s))));
        // The night side keeps a little light so a crescent still reads as a whole body.
        float lit = vKind > 0.5 ? 1.0 : 0.14 + 0.86 * smoothstep(-0.08, 0.3, dot(n, vLight));
        col = vColor * (lit * disc);
        a = disc;
    }
    gl_FragColor = vec4(col * vAlpha, a * vAlpha);
    ${TONE}
}
`;

/**
 * The Sun's quad (Medium and up): a screen-aligned billboard at uCenter, uHalfPx device px across
 * half its width, shaded by bodies.glsl.js DISC_FRAG with its radii in device px (uTanR = uHalfPx).
 */
export const SUN_VERT = /* glsl */`
uniform vec3 uCenter;
uniform float uHalfPx;
uniform vec2 uViewport;
varying vec2 vUv;
void main() {
    vec4 c = projectionMatrix * viewMatrix * vec4(uCenter, 1.0);
    vUv = position.xy;
    c.xy += position.xy * (2.0 * uHalfPx / uViewport) * c.w;
    gl_Position = c.w > 0.0 ? c : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

/**
 * Edge arrows for bodies off the screen: points at NDC `position.xy`, a chevron turned to aAngle
 * (radians from screen +x), aColor, aAlpha (0 hides it).
 */
export const ARROW_VERT = /* glsl */`
uniform float uDpr;
attribute vec3 aColor;
attribute float aAngle;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vRot;
void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vRot = vec2(cos(aAngle), sin(aAngle));
    gl_PointSize = 18.0 * uDpr;
    gl_Position = aAlpha > 0.0 ? vec4(position.xy, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

/** @see ARROW_VERT */
export const ARROW_FRAG = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
varying vec2 vRot;
void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    p.y = -p.y;
    // Into the arrow's frame: +x along its direction.
    vec2 a = vec2(dot(p, vRot), dot(p, vec2(-vRot.y, vRot.x)));
    // A chevron: two strokes meeting at the tip (0.55, 0).
    float d1 = abs(dot(a - vec2(0.55, 0.0), normalize(vec2(0.62, 1.0))));
    float d2 = abs(dot(a - vec2(0.55, 0.0), normalize(vec2(0.62, -1.0))));
    float along = a.x;
    float stroke = min(a.y > 0.0 ? d1 : d2, 1.0);
    float m = (1.0 - smoothstep(0.07, 0.16, stroke)) * step(-0.25, along) * (1.0 - step(0.6, along));
    if (m <= 0.0) discard;
    gl_FragColor = vec4(vColor * (m * vAlpha), m * vAlpha);
    ${TONE}
}
`;
