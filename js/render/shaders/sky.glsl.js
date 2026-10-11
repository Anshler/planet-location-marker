/**
 * GLSL for the celestial sphere (G5): the shared at-infinity projection, atmospheric extinction
 * helpers, stars, Milky Way, and the anti-aliased screen-space line used for constellation figures,
 * grids, the ecliptic and planet trails.
 *
 * Every fragment shader ends with the tonemapping/colorspace includes (SPEC R6).
 */

/**
 * At-infinity projection (SPEC E.1). Directions are projected with the view rotation only, so the
 * camera's translation is ignored, and the depth is pinned just inside the far plane: anything at a
 * finite distance (Earth, Moon) occludes the sky through the ordinary depth test.
 * Usage in a vertex shader: `gl_Position = infinityClip(normalize(mat3(modelMatrix) * position));`
 * @type {string}
 */
export const INFINITY_VERT_CHUNK = /* glsl */`
vec4 infinityClip(vec3 dirW) {
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * dirW, 1.0);
    return vec4(p.xy, p.w * 0.999999, p.w);
}
`;

/**
 * A falling smoothstep. smoothstep(edge0, edge1, x) is undefined for edge0 >= edge1 (GLSL ES 3.00
 * §8.3, and in MSL and SPIR-V), so a falling ramp spells out the spec's own formula instead: the
 * arithmetic drivers evaluate for the builtin, now defined for e0 > e1. (1.0 - smoothstep(e1, e0,
 * x) is the same curve but rounds differently, which moved a few pixels by 1 LSB.)
 * @type {string}
 */
export const SMOOTH_FALL_CHUNK = /* glsl */`
float smoothFall(float e0, float e1, float x) {
    float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}
`;

/**
 * Atmospheric extinction (sky view). Kasten–Young airmass from sin(altitude) and a per-channel
 * extinction of (0.10, 0.17, 0.30) mag/airmass, so low objects dim and redden. Mirrored in JS by
 * `extinctionRGB()` in js/render/bodies.js.
 * @type {string}
 */
export const EXTINCTION_CHUNK = /* glsl */`
float airmassKY(float sinAlt) {
    float s = clamp(sinAlt, 0.0, 1.0);
    return 1.0 / (s + 0.50572 * pow(degrees(asin(s)) + 6.07995, -1.6364));
}
vec3 extinctionRGB(float sinAlt) {
    return exp(-0.921034 * vec3(0.10, 0.17, 0.30) * airmassKY(sinAlt));
}
`;

const TONE = /* glsl */`
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
`;

/**
 * Stars as Points. A star is a Gaussian PSF: faint stars keep a fixed ~0.6 px sigma (so they never
 * shimmer as they cross pixels) and get dimmer; stars brighter than mag 2.5 grow and exceed 1.0 in
 * HDR so bloom gives them halos. Twilight raises the limiting magnitude (faint stars vanish first),
 * and in sky view low stars are dimmed/reddened by extinction and scintillate (high tier).
 */
export const STAR_VERT = /* glsl */`
uniform float uMagLimit;
uniform float uExposure;
uniform float uPx;
uniform float uZoom;
uniform float uHalo;
uniform float uTwinkle;
uniform float uTime;
uniform float uSkyBlend;
uniform vec3 uUp;
uniform float uSaturation;
uniform float uDisplay;
attribute float aMag;
attribute vec3 aColor;
varying vec3 vColor;
varying float vPeak;
varying float vSigma;
varying float vHalo;
${INFINITY_VERT_CHUNK}
${EXTINCTION_CHUNK}
${SMOOTH_FALL_CHUNK}
void main() {
    vec3 dir = normalize(mat3(modelMatrix) * position);
    // Twilight: the effective limiting magnitude brightens as exposure falls.
    float e = clamp(uExposure, 0.0, 1.0);
    float lim = mix(-1.0, uMagLimit, sqrt(e));
    float vis = smoothFall(lim + 0.35, lim - 0.45, aMag) * smoothstep(0.0, 0.04, e);
    // Flux relative to a mag-2.5 star, the "just saturated" reference. Below it the peak is
    // compressed (F^0.75) so mag-6 stars stay visible on a display; above it stars grow instead.
    float F = exp2(-1.3287712 * (aMag - 2.5));
    float grow = max(1.0, pow(F, 0.3));
    float sigmaPx = 0.78 * grow * pow(uZoom, 0.6) * uPx;
    float peak = 1.2 * (F < 1.0 ? pow(F, 0.75) : pow(F, 0.3)) * vis;
    vec3 col = aColor / max(dot(aColor, vec3(0.2126, 0.7152, 0.0722)), 0.25);
    col = mix(vec3(1.0), col, uSaturation);
    if (uSkyBlend > 0.0) {
        float sinAlt = dot(dir, uUp);
        vec3 T = extinctionRGB(sinAlt);
        col *= mix(vec3(1.0), T / max(T.g, 1e-4), uSkyBlend);
        peak *= mix(1.0, T.g, uSkyBlend);
        if (uTwinkle > 0.0) {
            // Scintillation grows toward the horizon; two incommensurate tones per star.
            float ph = fract(sin(dot(position, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * 6.2831853;
            float strength = uTwinkle * mix(1.0, 0.3, clamp(sinAlt, 0.0, 1.0));
            float tw = 0.6 * sin(uTime * (6.0 + 5.0 * fract(ph * 1.7)) + ph)
                     + 0.4 * sin(uTime * (11.0 + 7.0 * fract(ph * 3.1)) + ph * 2.3);
            peak *= 1.0 + 0.35 * strength * tw;
        }
    }
    float haloPx = sigmaPx * 3.5 * (1.0 + (0.8 + 1.2 * uHalo) * smoothstep(1.5, 40.0, F));
    float radiusPx = max(3.2 * sigmaPx, haloPx) + 1.0;
    gl_PointSize = 2.0 * radiusPx;
    vSigma = sigmaPx / radiusPx;
    vPeak = peak * uDisplay;
    vHalo = (0.03 + 0.07 * uHalo) * peak * uDisplay * smoothstep(1.5, 12.0, F);
    vColor = col;
    gl_Position = vis * peak > 0.002 ? infinityClip(dir) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

/** @see STAR_VERT */
export const STAR_FRAG = /* glsl */`
varying vec3 vColor;
varying float vPeak;
varying float vSigma;
varying float vHalo;
void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 >= 1.0) discard;
    float core = vPeak * exp(-0.5 * r2 / (vSigma * vSigma));
    float halo = vHalo * exp(-sqrt(r2) * 5.0) * (1.0 - r2);
    // Saturated cores read white; colour lives in the halo, as in photographs.
    vec3 c = mix(vColor, vec3(1.0), 0.6 * smoothstep(0.8, 4.0, core));
    gl_FragColor = vec4(c * core + vColor * halo, 1.0);
    ${TONE}
}
`;

/** Milky Way on an inverted unit sphere at infinity (SPEC E.5), with optional procedural detail. */
export const MW_VERT = /* glsl */`
varying vec3 vDir;
${INFINITY_VERT_CHUNK}
void main() {
    vDir = normalize(mat3(modelMatrix) * position);
    gl_Position = infinityClip(vDir);
}
`;

/**
 * @see MW_VERT. uMW holds the smooth isophote level v = L / 5.6 (scripts/build-milkyway.mjs);
 * brightness is pow(v, MW_GAMMA). A warmer, brighter bulge glows only around Sagittarius; the
 * rest of the band is a cool white. With uDetail > 0 (medium and high tiers) the raster is read
 * with a cubic B-spline and procedural structure is added in galactic coordinates, so nothing has
 * a seam: star-cloud mottling and faint field stars that follow the density, and dust (the Great
 * Rift from Cygnus through Aquila to Ophiuchus/Sagittarius, plus patchy lanes along the plane)
 * that dims and reddens. Noise octaves and star layers fade out once their cells shrink to a few
 * pixels, so wide views stay calm and zoomed views keep their texture. Static: no time input.
 */
export const MW_FRAG = /* glsl */`
uniform sampler2D uMW;
uniform vec2 uMWSize;
uniform float uDetail;
uniform float uExposure;
uniform float uGain;
uniform mat3 uToGal;
uniform float uSkyBlend;
uniform vec3 uUp;
uniform float uDisplay;
uniform float uDpr;
varying vec3 vDir;
const float PI = 3.14159265358979;
const float MW_GAMMA = 1.85;
vec2 sceneDirToRaDecUv(vec3 d) {
    vec3 e = vec3(d.x, -d.z, d.y);
    // atan(0, 0) is undefined (a pixel exactly on a pole vertex of the sphere): 0 there.
    float ra = (e.x == 0.0 && e.y == 0.0) ? 0.0 : atan(e.y, e.x);
    return vec2(fract(ra / (2.0 * PI)), 0.5 + asin(clamp(e.z, -1.0, 1.0)) / PI);
}
// Cubic B-spline lookup from four bilinear taps (GPU Gems 2, ch. 20): a magnified raster
// (0.18° per texel, 10-20 px per texel when zoomed) shows no bilinear facets.
float textureBSpline(sampler2D tex, vec2 uv, vec2 size) {
    vec2 p = uv * size - 0.5;
    vec2 i = floor(p);
    vec2 f = p - i;
    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 g0 = w0 + w1;
    vec2 g1 = w2 + w3;
    vec2 t0 = (i - 0.5 + w1 / g0) / size;
    vec2 t1 = (i + 1.5 + w3 / g1) / size;
    return g0.y * (g0.x * texture2D(tex, t0).r + g1.x * texture2D(tex, vec2(t1.x, t0.y)).r)
         + g1.y * (g0.x * texture2D(tex, vec2(t0.x, t1.y)).r + g1.x * texture2D(tex, t1).r);
}
float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), u.x),
                   mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), u.x), u.y),
               mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), u.x),
                   mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}
const mat3 OCT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
// Zero-mean fBm (about ±0.5). cellPx is the first octave's cell size in pixels; octaves fade out
// between 5 and 2 px and the loop stops at the first invisible one.
float fbm(vec3 p, float cellPx, int octaves) {
    float s = 0.0;
    float a = 0.5;
    for (int o = 0; o < 5; o++) {
        float k = smoothstep(2.0, 5.0, cellPx);
        if (o >= octaves || k <= 0.0) break;
        s += a * k * (vnoise(p) - 0.5);
        p = OCT * p * 2.07;
        cellPx *= 0.483;
        a *= 0.5;
    }
    return s;
}
// Faint field stars, at most one per cell of a 3-D grid (F cells per radian). A star is kept only
// if its direction lies well inside its own cell, so a pixel tests just its own cell and no star is
// clipped beyond 2 sigma; the layer fades in once cells reach 6 CSS px, so the fixed-size PSF
// never shimmers. More stars where the band is denser (dens); returns brightness and a colour index.
vec2 fieldStars(vec3 g, float F, float shift, float px, float dens) {
    float cellPx = 1.0 / (F * px);                          // device pixels
    float fade = smoothstep(5.0, 8.0, cellPx / uDpr);
    if (fade <= 0.0) return vec2(0.0);
    vec3 c = floor(g * F + shift);
    if (hash13(c + 0.5) > dens) return vec2(0.0);
    vec3 o = vec3(hash13(c + 17.31), hash13(c + 41.73), hash13(c + 73.19));
    vec3 s = normalize(c + 0.25 + 0.5 * o - shift) * F + shift;
    vec3 m = s - c;
    if (min(min(m.x, m.y), m.z) < 0.25 || max(max(m.x, m.y), m.z) > 0.75) return vec2(0.0);
    float r = length(g * F + shift - s) * cellPx / (0.75 * uDpr);  // PSF sigma 0.75 CSS px
    float bri = hash13(c + 91.7);
    return vec2(fade * bri * bri * bri * exp(-0.5 * r * r), o.x);
}
float gauss(float x) { return exp(-0.5 * x * x); }
// Great Rift: a lane just north of the plane from Cygnus (l ≈ 85°) through Aquila (bending to
// b ≈ +4° near l = 28°) into Ophiuchus/Sagittarius, following the troughs of the contour data;
// broad in Cygnus and Ophiuchus, narrower through Aquila.
float riftLane(float l, float b) {
    float along = smoothstep(-12.0, -2.0, l) * (1.0 - smoothstep(80.0, 90.0, l));
    float centre = 0.8 + 3.0 * gauss((l - 28.0) / 5.0) + 2.0 * gauss((l - 3.0) / 6.0);
    float width = 1.4 + 0.9 * smoothstep(40.0, 75.0, l) + 0.9 * gauss((l - 5.0) / 8.0);
    return along * (1.0 - 0.25 * smoothstep(40.0, 75.0, l)) * gauss((b - centre) / width);
}
void main() {
    vec3 d = normalize(vDir);
    float px = max(length(dFdx(vDir)), length(dFdy(vDir)));   // radians per pixel
    vec2 uv = sceneDirToRaDecUv(d);
    float v = uDetail > 0.0 ? textureBSpline(uMW, uv, uMWSize) : texture2D(uMW, uv).r;
    if (v < 0.002) discard;
    vec3 g = uToGal * d;                       // x → galactic centre, z → north galactic pole
    float l = (g.x == 0.0 && g.y == 0.0) ? 0.0 : degrees(atan(g.y, g.x));   // atan(0, 0) is undefined
    float b = degrees(asin(clamp(g.z, -1.0, 1.0)));
    // The bulge, seen mostly south of the plane where the dust lets its light through.
    float bulge = gauss(l / 9.0) * gauss((b + 3.0) / 5.5);
    float I = pow(v, MW_GAMMA) * (1.0 + 0.5 * bulge);
    vec3 tau = vec3(0.0);
    float stars = 0.0;
    float starHue = 0.5;
    if (uDetail > 0.0 && v > 0.01) {
        float dens = clamp(1.6 * v, 0.0, 1.0);
        vec3 q = g * vec3(1.0, 1.0, 1.3);      // features elongated along the plane
        float clouds = fbm(q * 40.0, 1.0 / (40.0 * px), 3);
        float mottle = fbm(q * 160.0 + 23.0, 1.0 / (160.0 * px), 3);
        I *= max(0.0, 1.0 + (0.5 + 0.5 * dens) * clouds + 0.5 * dens * mottle);
        // Dust: fBm stretched along the plane and gently domain-warped, so lanes come out wispy.
        vec3 qd = g * vec3(1.0, 1.0, 2.0);
        vec3 warp = vec3(vnoise(qd * 12.0 + 3.1), vnoise(qd * 12.0 + 9.7), vnoise(qd * 12.0 + 5.3)) - 0.5;
        float dn = 0.5 + fbm(qd * 30.0 + 41.0 + 2.0 * warp, 1.0 / (30.0 * px), 5);
        float lane = riftLane(l, b) + 0.2 * gauss(b / 2.2);
        tau = lane * (0.3 + 0.9 * smoothstep(0.45, 0.7, dn)) * vec3(0.82, 1.0, 1.22);
        // Field stars cluster in the bright clouds and thin out in the dust lanes (besides being
        // dimmed by them below), so the lanes read as dark rather than as evenly starry.
        float sd = clamp((0.2 + 0.75 * dens) * (1.0 + 1.5 * clouds) * exp(-1.6 * tau.y), 0.0, 1.0);
        vec2 s0 = fieldStars(g, 60.0, 0.0, px, sd);
        vec2 s1 = fieldStars(g, 150.0, 0.0, px, sd);
        vec2 s2 = fieldStars(g, 150.0, 0.5, px, sd);
        vec2 s3 = fieldStars(g, 375.0, 0.0, px, sd);
        vec2 s4 = fieldStars(g, 375.0, 0.5, px, sd);
        vec2 s5 = fieldStars(g, 940.0, 0.0, px, sd);
        vec2 s6 = fieldStars(g, 940.0, 0.5, px, sd);
        vec4 sw = vec4(1.2 * s0.x, 0.9 * (s1.x + s2.x), 0.7 * (s3.x + s4.x), 0.5 * (s5.x + s6.x));
        float sum = sw.x + sw.y + sw.z + sw.w;
        starHue = (sw.x * s0.y + sw.y * max(s1.y, s2.y) + sw.z * max(s3.y, s4.y) + sw.w * max(s5.y, s6.y)) / max(1e-4, sum);
        stars = sum * (0.7 + 0.3 * uSkyBlend);   // quieter from orbit
    }
    vec3 tint = mix(vec3(0.84, 0.89, 1.0), vec3(1.0, 0.93, 0.83), smoothstep(0.1, 0.9, bulge));
    vec3 starCol = mix(vec3(0.78, 0.86, 1.0), vec3(1.0, 0.88, 0.72), starHue);
    vec3 col = (tint * I + starCol * stars) * exp(-tau) * (uGain * uExposure * uDisplay);
    if (uSkyBlend > 0.0) {
        // Extinction flattens the band toward the horizon in sky view.
        float s = clamp(dot(d, uUp), 0.0, 1.0);
        col *= mix(1.0, smoothstep(0.0, 0.35, s), uSkyBlend);
    }
    gl_FragColor = vec4(col, 1.0);
    ${TONE}
}
`;

/**
 * Screen-space anti-aliased line segments at infinity, one instance per segment (4 vertices).
 * Each instance carries both endpoint directions, so the vertex shader can clip the chord against
 * the eye plane, extrude it in pixels and pass the segment's screen length: the fragment shader
 * then cuts a gap around real endpoints (constellation lines stop short of their stars) and
 * draws dashes. A chord between two directions projects to the great-circle arc between them.
 * Base `position`: x = end (0 = A, 1 = B), y = side (-1/+1).
 * Instance attributes: iA, iB (directions), iStyle (x = alpha multiplier, y = highlight flag,
 * z/w = a per-endpoint parameter, e.g. the trail's sample index at A and B).
 */
export const LINE_VERT = /* glsl */`
uniform vec2 uViewport;
uniform float uHalfWidth;
uniform float uGap;
attribute vec3 iA;
attribute vec3 iB;
attribute vec4 iStyle;
varying float vSide;
varying vec2 vAlongW;
varying float vLen;
varying vec2 vGap;
varying vec2 vStyle;
varying float vParam;
${INFINITY_VERT_CHUNK}
void main() {
    vStyle = iStyle.xy;
    vParam = mix(iStyle.z, iStyle.w, position.x);
    mat3 R = mat3(viewMatrix) * mat3(modelMatrix);
    vec3 a0 = R * normalize(iA);
    vec3 b0 = R * normalize(iB);
    const float ZC = -1e-3;
    if ((a0.z > ZC && b0.z > ZC) || iStyle.x <= 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vSide = 0.0; vAlongW = vec2(0.0, 1.0); vLen = 0.0; vGap = vec2(0.0);
        return;
    }
    bool clipA = a0.z > ZC;
    bool clipB = b0.z > ZC;
    float tc = (ZC - a0.z) / (b0.z - a0.z);
    vec3 a = clipA ? mix(a0, b0, tc) : a0;
    vec3 b = clipB ? mix(a0, b0, tc) : b0;
    vec4 ca = projectionMatrix * vec4(a, 1.0);
    vec4 cb = projectionMatrix * vec4(b, 1.0);
    vec2 sa = ca.xy / ca.w * 0.5 * uViewport;
    vec2 sb = cb.xy / cb.w * 0.5 * uViewport;
    vec2 d = sb - sa;
    float len = length(d);
    vec2 t = len > 1e-3 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-t.y, t.x);
    float hw = uHalfWidth + 1.0;
    bool atB = position.x > 0.5;
    vec4 c = atB ? cb : ca;
    c.xy += n * (position.y * hw) * 2.0 / uViewport * c.w;
    gl_Position = vec4(c.xy, c.w * 0.999999, c.w);
    vSide = position.y * hw;
    // (along * w, w): their ratio interpolates linearly in screen space despite perspective.
    vAlongW = vec2(atB ? len : 0.0, 1.0) * c.w;
    vLen = len;
    vGap = vec2(clipA ? -1.0 : uGap, clipB ? -1.0 : uGap);
}
`;

/**
 * @see LINE_VERT. Defines: TRAIL (fade/dash by vParam against uNow; vParam is the sample index),
 * HIGHLIGHT (iStyle.y > 0.5 switches to uHighlightColor).
 */
export const LINE_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform float uHalfWidth;
uniform vec3 uHighlightColor;
uniform float uNow;
uniform float uSpan;
uniform float uDpr;
varying float vSide;
varying vec2 vAlongW;
varying float vLen;
varying vec2 vGap;
varying vec2 vStyle;
varying float vParam;
${SMOOTH_FALL_CHUNK}
void main() {
    float along = vAlongW.x / vAlongW.y;
    float cov = clamp(uHalfWidth + 0.5 - abs(vSide), 0.0, 1.0);
    float g = 1.0;
    if (vGap.x > 0.0) g *= smoothstep(vGap.x, vGap.x + 1.5, along);
    if (vGap.y > 0.0) g *= smoothstep(vGap.y, vGap.y + 1.5, vLen - along);
    vec3 col = uColor;
    float a = uAlpha * vStyle.x;
#ifdef HIGHLIGHT
    if (vStyle.y > 0.5) { col = uHighlightColor; }
#endif
#ifdef TRAIL
    // Past (before uNow) is dimmer and dashed; both ends fade out.
    float past = step(vParam, uNow);
    float dash = mix(1.0, step(0.45, fract(along / (7.0 * uDpr))), past);
    float ends = smoothstep(0.0, 0.12 * uSpan, vParam) * smoothFall(uSpan, 0.88 * uSpan, vParam);
    a *= mix(1.0, 0.45, past) * dash * (0.25 + 0.75 * ends);
#endif
    a *= cov * g;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(col, a);
    ${TONE}
}
`;
