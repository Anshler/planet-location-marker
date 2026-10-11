/**
 * GLSL for the sky-view ground and atmosphere (G5, SPEC E.5): the ground hemisphere with horizon
 * haze, and the patches applied to three's Preetham Sky.js material — a twilight/night model for
 * the sky Preetham cannot draw once the Sun is below the horizon, crossfade and eclipse dimming.
 * Every fragment shader ends with the tonemapping/colorspace includes (SPEC R6). smoothstep() always
 * takes edge0 < edge1 (reversed edges are undefined in GLSL, MSL and SPIR-V): falling ramps use
 * smoothFall (SMOOTH_FALL_CHUNK).
 */
import { INFINITY_VERT_CHUNK, SMOOTH_FALL_CHUNK } from './sky.glsl.js';
import { FINITE_CHUNK } from './common.glsl.js';

/**
 * Twilight and night sky, added to Preetham's output. Inputs come from Sky.js (`up`,
 * `vSunDirection`) plus `uSunAltDeg`, `uObscuration` and `uEclFloor`. Models: the sunward horizon glow
 * (yellow → orange → red as the Sun sinks), the deep blue twilight dome, Earth's shadow and the
 * pink Belt of Venus on the anti-solar side, faint airglow toward the horizon at night, and the
 * 360° sunset ring seen during totality.
 * @type {string}
 */
export const TWILIGHT_CHUNK = /* glsl */`
uniform float uSunAltDeg;
uniform float uObscuration;
uniform float uEclFloor;
${SMOOTH_FALL_CHUNK}
vec3 twilightSky(vec3 dir) {
    float h = dot(dir, up);
    // Every argument below is clamped to its function's domain. Two unit vectors' dot can land an
    // ulp outside [-1, 1]; pow() of the resulting tiny negative base is NaN on ANGLE/D3D11 and
    // Metal, NaN × 0 is still NaN, and bloom then smears one NaN pixel into a black rectangle.
    float hp = clamp(h, 0.0, 1.0);
    float altDeg = degrees(asin(hp));
    float s = -uSunAltDeg;
    vec3 sunH = vSunDirection - up * dot(vSunDirection, up);
    float sl = length(sunH);
    vec3 dH = dir - up * h;
    float dl = length(dH);
    float cAz = (sl > 1e-5 && dl > 1e-5) ? clamp(dot(dH / dl, sunH / sl), -1.0, 1.0) : 0.0;
    float sunward = clamp(0.5 + 0.5 * cAz, 0.0, 1.0);
    // (e-folding 4.2° of depression: civil twilight's blue hour stays blue, where 3.2° left the sky
    // navy by −3°.)
    float k = smoothFall(4.0, -1.0, uSunAltDeg) * exp(-max(s, 0.0) / 4.2);
    // Deep blue twilight dome, a little brighter on the Sun's side and toward the horizon.
    vec3 col = vec3(0.075, 0.13, 0.30) * (0.55 + 0.45 * sunward) * (1.0 - 0.35 * hp) * k;
    // Sunward horizon glow, flattening and reddening with depression.
    float glowH = exp(-hp / mix(0.13, 0.05, smoothstep(0.0, 9.0, s)));
    float glowAz = pow(max(sunward, 0.0), mix(2.5, 6.0, smoothstep(0.0, 10.0, s)));
    vec3 warm = mix(vec3(1.0, 0.60, 0.28), vec3(0.95, 0.30, 0.10), smoothstep(-1.0, 7.0, s));
    col += warm * glowH * glowAz * 1.3 * k;
    // Earth's shadow rising in the anti-solar sky, the Belt of Venus just above it.
    float anti = pow(max(1.0 - sunward, 0.0), 1.5);
    float edge = 1.0 + 1.1 * clamp(s, 0.0, 9.0);
    float season = smoothstep(-1.5, 1.0, s) * (1.0 - smoothstep(5.0, 10.0, s));
    float zb = (altDeg - edge - 5.0) / 4.5;
    float belt = exp(-zb * zb) * season;
    float shade = (1.0 - smoothstep(edge - 1.0, edge + 2.0, altDeg)) * season;
    col += vec3(0.85, 0.48, 0.58) * belt * anti * 0.22 * exp(-max(s, 0.0) / 4.0);
    col *= 1.0 - 0.5 * shade * anti;
    // Night: natural sky floor plus airglow brightening toward the horizon (van Rhijn).
    float night = smoothFall(-8.0, -16.0, uSunAltDeg);
    // (ACES' toe crushes these levels about 6x, so the horizon band needs this much to read
    // against the dark ground.)
    col += (vec3(0.0010, 0.0014, 0.0026) + vec3(0.0105, 0.0140, 0.0180) * exp(-hp / 0.11)) * night;
    // Solar eclipse: totality's deep-blue sky fades in as the daylight goes (uEclFloor, set by
    // ground.js together with uDayGain so their sum falls steadily to the totality level instead
    // of dipping to black around 2nd/3rd contact), and in totality every horizon glows like a
    // sunset.
    float tot = smoothstep(0.985, 1.0, uObscuration);
    col += vec3(1.0, 0.55, 0.25) * exp(-hp / 0.08) * 0.10 * tot + vec3(0.02, 0.035, 0.07) * uEclFloor;
    return col * smoothstep(-0.03, 0.0, h);
}
// Golden-hour grading. Preetham keeps a low Sun's Mie glow nearly white, but light near a low Sun
// has crossed hundreds of kilometres of air: warm it around the Sun and toward the horizon.
vec3 goldenHour(vec3 c, vec3 dir) {
    float gold = (1.0 - smoothstep(0.0, 12.0, uSunAltDeg)) * smoothstep(-5.0, -0.5, uSunAltDeg);
    float near = pow(max(dot(dir, vSunDirection), 0.0), 4.0);
    float low = exp(-max(dot(dir, up), 0.0) / 0.22);
    float w = gold * clamp(0.2 + 0.8 * near, 0.0, 1.0) * low;
    return c * mix(vec3(1.0), vec3(1.30, 0.80, 0.48), w);
}
// Soft highlight knee (asymptote ~0.88): Preetham's Mie column under the Sun would otherwise sit
// above the bloom threshold and bloom into a white slab; only the Sun billboard should bloom.
vec3 skyKnee(vec3 c) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return l > 0.6 ? c * ((0.6 + (l - 0.6) / (1.0 + (l - 0.6) / 0.28)) / l) : c;
}
`;

/**
 * Text patches applied to Sky.SkyShader.fragmentShader (r170). Each [search, replace]; every
 * search string must occur in the vendored shader (ground.js counts them, and a unit test checks
 * them against vendor/three), so a three.js upgrade cannot silently drop one.
 */
export const SKY_PATCHES = [
    ['uniform vec3 up;', `uniform vec3 up;
uniform float uFloor;
uniform float uDayGain;
uniform float uFade;
uniform float uDisplay;
${FINITE_CHUNK}
${TWILIGHT_CHUNK}`],
    // Domain guards: dot() of two unit vectors can exceed 1 by an ulp (acos → NaN), and pow() of
    // a negative base is undefined (NaN on Metal; D3D only survives integer exponents).
    ['float zenithAngle = acos( max( 0.0, dot( up, direction ) ) );',
        'float zenithAngle = acos( clamp( dot( up, direction ), 0.0, 1.0 ) );'],
    ['return THREE_OVER_SIXTEENPI * ( 1.0 + pow( cosTheta, 2.0 ) );',
        'return THREE_OVER_SIXTEENPI * ( 1.0 + cosTheta * cosTheta );'],
    ['clamp( pow( 1.0 - dot( up, vSunDirection ), 5.0 ), 0.0, 1.0 )',
        'clamp( pow( max( 1.0 - dot( up, vSunDirection ), 0.0 ), 5.0 ), 0.0, 1.0 )'],
    // Preetham's constant "night floor" turns a dark sky grey once the Sun has set.
    ['vec3 L0 = vec3( 0.1 ) * Fex;', 'vec3 L0 = vec3( 0.1 ) * Fex * uFloor;'],
    // Our own HDR Sun billboard draws the disc (with extinction and a pixel minimum).
    ['L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', 'L0 += ( vSunE * 19000.0 * Fex ) * sundisk * 0.0;'],
    ['vec3( 0.0, 0.0003, 0.00075 );', 'vec3( 0.0, 0.0003, 0.00075 ) * uFloor;'],
    ['gl_FragColor = vec4( retColor, 1.0 );',
        'gl_FragColor = vec4( pcFinite( skyKnee( ( goldenHour( retColor, direction ) * uDayGain + twilightSky( direction ) ) * uDisplay ) * uFade ), 1.0 );'],
];

/** Ground hemisphere at infinity (inverted sphere), with the horizon haze, in one draw. */
export const GROUND_VERT = /* glsl */`
varying vec3 vDir;
${INFINITY_VERT_CHUNK}
void main() {
    vDir = normalize(mat3(modelMatrix) * position);
    gl_Position = infinityClip(vDir);
}
`;

/**
 * Premultiplied output (blend ONE, ONE_MINUS_SRC_ALPHA): the ground covers everything below the
 * horizon with normal-blend alpha, while the haze above it is purely additive. Drawn without a
 * depth test so the Moon, planets and Sun below the horizon are hidden too.
 *
 * By day the ground is lit like the land it stands for: albedo ~0.3 under skylight plus direct
 * Sun growing with its altitude, at the sky's own exposure, so it reads mid-grey under a blue sky
 * (it used to stay near-black, and the globe-to-sky descent dipped through a black screen).
 * Toward the horizon it fades into the haze (aerial perspective from the 3 km eye); at night it
 * is near-black. uDayGain/uEclFloor are the sky's eclipse terms (ground.js), so a solar eclipse
 * darkens the land with the sky instead of brightening it with the rising exposure. During a
 * globe ↔ sky transition uCover reaches 1 ahead of the sky blend, so the ground hides the globe
 * before the camera tilts its rim into view.
 */
export const GROUND_FRAG = /* glsl */`
uniform vec3 uUp;
uniform vec3 uSunDir;
uniform float uSunAltDeg;
uniform float uCover;     // groundCover(skyBlend) in ground.js: 0 in orbit view, 1 in sky view
uniform float uDisplay;
uniform float uDayGain;
uniform float uEclFloor;
varying vec3 vDir;
${SMOOTH_FALL_CHUNK}
void main() {
    vec3 d = normalize(vDir);
    float h = clamp(dot(d, uUp), -1.0, 1.0);
    float dayK = smoothstep(-6.0, 6.0, uSunAltDeg);
    // Daylight on the ground (before exposure): skylight, which fades through civil twilight (the
    // land stays far darker than the glowing horizon at dusk), plus the direct Sun with its altitude.
    float sunS = sin(radians(clamp(uSunAltDeg, 0.0, 90.0)));
    float sky = smoothstep(-7.0, 3.0, uSunAltDeg);
    float light = (0.30 * sky * sky + 0.70 * pow(max(sunS, 1e-6), 0.7) * smoothstep(-1.0, 2.0, uSunAltDeg)) * uDayGain;
    vec3 groundCol = vec3(0.0022, 0.0026, 0.0036) * (1.0 - dayK) + vec3(0.36, 0.35, 0.29) * light
        + vec3(0.006, 0.009, 0.014) * uEclFloor;
    vec3 hazeCol = vec3(0.05, 0.07, 0.12) * (1.0 - dayK) + vec3(0.6, 0.7, 0.85) * dayK * uDayGain
        + vec3(0.03, 0.04, 0.07) * uEclFloor;
    // Warm haze toward the Sun's azimuth around sunrise/sunset.
    vec3 sunH = uSunDir - uUp * dot(uSunDir, uUp);
    vec3 dH = d - uUp * h;
    float sl = length(sunH), dl = length(dH);
    float cAz = (sl > 1e-5 && dl > 1e-5) ? clamp(dot(dH / dl, sunH / sl), -1.0, 1.0) : 0.0;
    float low = 1.0 - smoothstep(0.0, 7.0, abs(uSunAltDeg + 1.0));
    float sw = clamp(0.5 + 0.5 * cAz, 0.0, 1.0);
    sw *= sw;
    hazeCol = mix(hazeCol, vec3(1.0, 0.55, 0.28) * (0.35 + 0.65 * dayK) * uDayGain, low * sw * sw);
    hazeCol *= mix(0.25, 1.0, smoothstep(-14.0, -2.0, uSunAltDeg));
    // Aerial perspective: the far ground fades into the horizon haze (only faintly at night).
    float aer = exp(min(h, 0.0) / 0.07) * mix(0.2, 0.85, dayK);
    vec3 ground = mix(groundCol, hazeCol * mix(0.25, 1.5, dayK), aer);
    float a = smoothFall(0.0025, -0.0025, h);
    vec3 haze = exp(-max(h, 0.0) / 0.03) * hazeCol * 0.25 * (1.0 - a);
    gl_FragColor = vec4((ground * a + haze) * uCover * uDisplay, a * uCover);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;
