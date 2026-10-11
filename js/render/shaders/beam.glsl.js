/**
 * Beam ribbon shaders (SPEC §E.4): one instanced screen-space ribbon per body.
 *
 * Geometry: a 24-segment strip whose `position` attribute carries
 * (aS ∈ [0, 1], aSide ∈ {−1, +1}, 0); nine instances in BODIES order.
 * Instance attributes: iOrigin, iDir, iColor (linear), iLen, iState
 * (x selected, y below horizon, z visible, w launch progress).
 *
 * Design notes (deviations from the literal spec formulas, for robustness):
 *  - The ribbon's cross-section coordinate is NOT an interpolated varying.
 *    Perspective-correct interpolation of a screen-space offset across a quad
 *    whose ends have very different w skews the profile (the core zig-zags by
 *    up to a third of the half-width). Instead the vertex shader computes the
 *    exact projected centre line (the homogeneous 2D line through the
 *    projected origin and the vanishing point of the beam direction) and the
 *    fragment shader measures its distance from gl_FragCoord in pixels.
 *  - Near-plane trimming happens in view space (z ≤ −1.01·near), so a beam
 *    passing behind the camera never produces w ≤ 0 vertices.
 *  - A beam seen end-on (its visible part projects to less than ~¾ of the
 *    ribbon half-width, e.g. a body at the zenith seen from straight above)
 *    is drawn as a round glow instead of a degenerate sliver.
 *  - Launch progress grows the beam log-uniformly (length L0·(L/L0)^w), so the
 *    growth is visible in perspective instead of being over in two frames.
 *  - Light-time pulses travel from the planet toward the observer (phase
 *    log(1+d)·0.9 + t·0.6); the spec's sign moved them outward.
 *  - Dashes and pulses are box-filtered with fwidth so they fade to their mean
 *    instead of shimmering where they shrink below a pixel near the
 *    vanishing point.
 *
 * Both passes share these sources; pass B (x-ray, GreaterDepth) adds
 * `#define XRAY`.
 *
 * @module render/shaders/beam.glsl
 */
import { FINITE_CHUNK } from './common.glsl.js';

/** Vertex shader for both beam passes. */
export const BEAM_VERT = /* glsl */ `
uniform float uNear;      // camera near plane (view-space units)
uniform vec2 uViewport;   // drawing-buffer size in px
uniform float uGlowPx;    // unselected ribbon half-width in drawing-buffer px

attribute vec3 iOrigin;
attribute vec3 iDir;
attribute vec3 iColor;
attribute float iLen;
attribute vec4 iState;    // selected, below, visible, launch progress

varying float vDist;      // distance from the origin along the beam (Earth radii)
flat varying vec4 vLine;  // ribbon: (a, b, c, 0) with a·x + b·y + c = signed px distance; disc: (cx, cy, 0, 1)
flat varying vec3 vColor;
flat varying vec4 vState;
flat varying vec3 vLen;   // (current length, full length, half-width px)

const float L0 = 0.02;    // length at launch progress 0 (Earth radii)

void main() {
    vColor = iColor;
    vState = iState;
    vDist = 0.0;
    vLine = vec4(0.0);
    float halfW = uGlowPx * (iState.x > 0.5 ? 1.4 : 1.0);
    float full = max(iLen, L0);
    float len = iState.w >= 1.0 ? full : L0 * pow(full / L0, clamp(iState.w, 0.0, 1.0));
    vLen = vec3(len, full, halfW);

    // Default: collapse outside the clip volume (hidden, unlaunched or behind the camera).
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    if (iState.z < 0.5 || iState.w <= 0.0) return;

    vec3 O = (viewMatrix * vec4(iOrigin, 1.0)).xyz;
    vec3 D = normalize(mat3(viewMatrix) * iDir);

    // Trim the segment to z <= zc in view space.
    float zc = -uNear * 1.01;
    float oz = O.z;
    float ez = O.z + D.z * len;
    if (oz > zc && ez > zc) return;
    float a = 0.0;
    float b = 1.0;
    if (oz > zc) a = (zc - oz) / (ez - oz);
    if (ez > zc) b = (zc - oz) / (ez - oz);

    // Exact projected centre line: through the projected origin and the vanishing point of D.
    vec4 cO = projectionMatrix * vec4(O, 1.0);
    vec4 cD = projectionMatrix * vec4(D, 0.0);
    vec3 l = cross(cO.xyw, cD.xyw);
    vec2 ab = 2.0 * l.xy / uViewport;
    float nrm = length(ab);

    // Projected extent of the visible part (end-on detection).
    vec4 cA = projectionMatrix * vec4(O + D * (len * a), 1.0);
    vec4 cB = projectionMatrix * vec4(O + D * (len * b), 1.0);
    vec2 pA = (cA.xy / cA.w * 0.5 + 0.5) * uViewport;
    vec2 pB = (cB.xy / cB.w * 0.5 + 0.5) * uViewport;
    bool endOn = length(pB - pA) < 0.75 * halfW || !(nrm > 1e-12);

    if (endOn) {
        // Looking down the beam: a round glow centred on the visible part.
        vec2 c = 0.5 * (pA + pB);
        vec2 corner = vec2(position.y, position.x < 0.5 ? -1.0 : 1.0) * halfW;
        vec2 ndc = (c + corner) / uViewport * 2.0 - 1.0;
        gl_Position = vec4(ndc, clamp(cA.z / cA.w, -1.0, 1.0), 1.0);
        vLine = vec4(c, 0.0, 1.0);
        vDist = len * b;
        return;
    }

    vec2 n = ab / nrm;
    vLine = vec4(n, (l.z - l.x - l.y) / nrm, 0.0);

    // Cubic spacing puts most rows near the observer, where the projection changes fastest.
    float s = a + (b - a) * position.x * position.x * position.x;
    vec3 P = O + D * (len * s);
    vec4 cP = projectionMatrix * vec4(P, 1.0);
    cP.xy += n * (position.y * halfW * 2.0) / uViewport * cP.w;
    gl_Position = cP;
    vDist = len * s;
}
`;

/** Fragment shader for both beam passes (`#define XRAY` selects pass B). */
export const BEAM_FRAG = /* glsl */ `
${FINITE_CHUNK}
uniform float uDpr;
uniform float uPulses;    // 0..1, eased toward FrameInfo.pulsesActive
uniform float uPhase;     // pulse phase, advanced at 0.6 cycles/s on the CPU (no float drift)
uniform float uFade;      // 1 in orbit, 0 once sky view has taken over
uniform float uSelActive; // 1 while any body is selected (others dim)

varying float vDist;
flat varying vec4 vLine;
flat varying vec3 vColor;
flat varying vec4 vState;
flat varying vec3 vLen;

// Box-filtered square wave: 1 on [0, 0.5), 0 on [0.5, 1); w = filter width.
float dashFiltered(float x, float w) {
    w = max(w, 1e-4);
    float x0 = x - 0.5 * w;
    float x1 = x + 0.5 * w;
    float f0 = floor(x0) * 0.5 + min(fract(x0), 0.5);
    float f1 = floor(x1) * 0.5 + min(fract(x1), 0.5);
    return (f1 - f0) / w;
}

void main() {
    bool disc = vLine.w > 0.5;
    float side = disc
        ? length(gl_FragCoord.xy - vLine.xy)
        : abs(dot(vLine.xyz, vec3(gl_FragCoord.xy, 1.0)));
    float halfW = vLen.z;
    float len = vLen.x;
    float full = vLen.y;
    float sel = step(0.5, vState.x);
    float below = step(0.5, vState.y);

    // vDist is an interpolated varying: with MSAA a partly covered pixel is shaded at its centre,
    // outside the primitive, where the extrapolated value can be far outside [0, full] (−16376 was
    // measured on a ribbon spanning the near plane to 2000 ER). log() of that is NaN, NaN × 0 is
    // NaN, and additive blending would then poison the pixel underneath. Use only the clamped d.
    float d = clamp(vDist, 0.0, vLen.y);

    // Derivatives first, in uniform control flow.
    float lg = log(1.0 + d);
    float ph = lg * 0.9 + uPhase;
    float phW = fwidth(ph);
    float dashX = d * 12.0;
    float dashW = fwidth(dashX);

    // Cross-section: a thin HDR core inside a soft glow that reaches zero at the ribbon edge.
    float corePx = mix(1.6, 2.6, sel) * uDpr;
    float q = side / corePx;
    float core = exp(-2.0 * q * q);
    float glow = exp(-side / (halfW * 0.35)) * (1.0 - smoothstep(0.55 * halfW, halfW, side));

    float fadeIn = disc ? 1.0 : smoothstep(0.0, 0.03, d);
    float glowIn = disc ? 1.0 : smoothstep(0.0, 0.12, d);
    float u = d / full;
    float fadeOut = full < 500.0
        ? 1.0 - smoothstep(0.985, 1.0, u)                 // finite target (the Moon): touch it
        : 1.0 - smoothstep(0.6, 1.0, pow(max(u, 0.0), 1.0 / 3.0));  // at infinity: fade into the glyph

    // Light-time pulses: sharp front toward the observer, soft tail toward the planet.
    float f = disc ? fract(uPhase) : fract(ph);
    float pulse = smoothstep(0.0, 0.02, f) * exp(-f * 18.0);
    pulse *= uPulses * (disc ? 1.0 : 1.0 - smoothstep(0.1, 0.35, phW));

    // Leading head while the beam is launching.
    float hd = clamp(1.0 - (log(1.0 + len) - lg) * 5.0, 0.0, 1.0);
    float head = hd * hd * hd * (1.0 - smoothstep(0.9, 1.0, vState.w));

    float dash = disc ? 1.0 : dashFiltered(dashX, dashW);

#ifdef XRAY
    // Pass B: only where the beam is hidden (inside or behind the Earth): dashed and faint. The
    // dashes cut the core only: dashing the wide glow too drew each dash as a bar across the
    // ribbon, a barcode wherever a beam is seen at a grazing angle.
    float k = 0.22 * mix(1.0, 1.4, sel) * (1.0 - 0.45 * uSelActive * (1.0 - sel));
    vec3 c = vColor * (core * 2.2 * dash + glow * 0.3 * glowIn * 0.5) * fadeIn * fadeOut * k;
#else
    // Below the horizon: a thin, dim, dashed core with only a whisper of glow, so the
    // bodies you can actually see keep the visual hierarchy.
    float k = mix(1.0, 0.3, below) * mix(1.0, 1.6, sel) * (1.0 - 0.45 * uSelActive * (1.0 - sel));
    float dashA = mix(1.0, dash, below);
    float glowK = mix(1.0, 0.3, below);
    // A travelling pulse is a bead: the core dips slightly between beads and each bead
    // carries its own wider halo, so the motion reads even where the core saturates.
    float bead = pulse * exp(-side / (halfW * 0.5));
    float coreK = 2.2 * (1.0 - 0.3 * uPulses) + 2.6 * pulse + 3.0 * head;
    // Only the core is dashed (see pass B); the faint glow of a beam below the horizon is continuous.
    vec3 c = vColor * (core * coreK * dashA + glow * glowIn * glowK * mix(0.6, 0.3, below) + bead * glowIn * 1.6 * dashA)
           * fadeIn * fadeOut * k;
#endif

    // Per-material guard as well: one non-finite value here would erase the pixel underneath.
    gl_FragColor = vec4(pcFinite(c * uFade), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;
