/**
 * Cloud shell shader (SPEC §E.2, shell r = 1.006, alpha-blended over the Earth).
 *
 * Cloud tops are lit by sunlight filtered through the shared atmosphere model
 * at their own altitude, so after the ground terminator they glow gold, then
 * red, then go dark, with the colour sequence of a real sunset. Clouds are
 * volumes, so lighting wraps past grazing. The unlit deck is a faint cool grey
 * (moonlight), city lights glow through it at night, slant paths near the limb
 * read thicker, and the same aerial perspective as the surface keeps clouds
 * inside the air.
 */
import { COMMON, SURFACE_FRAG } from './common.glsl.js';
import { ATMO_MODEL } from './atmosphere.glsl.js';
import { SURFACE_VERTEX, CLOUD_LOOKUP } from './earth.glsl.js';

const vertex = SURFACE_VERTEX;

const fragment = /* glsl */ `
uniform sampler2D uClouds;
uniform sampler2D uNight;
uniform vec3 uSunDirW;
uniform float uSunE;
uniform float uLightsGain;
uniform float uHazeE;
uniform float uCloudMode;
uniform float uCloudShift;
uniform float uAtmo;
uniform float uFade;
uniform vec4 uEclipse;
uniform vec3 uMoonPosW;

varying vec3 vPosL;
varying vec3 vPosW;
varying vec3 vNw;

${COMMON}
${SURFACE_FRAG}
${ATMO_MODEL}
${CLOUD_LOOKUP}

const float CLOUD_TOP = 0.006;   // shell altitude in Earth radii

void main() {
    vec3 pl = normalize(vPosL);
    vec3 Ng = normalize(vNw);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 L = normalize(uSunDirW);
    float mu = dot(Ng, L);
    vec2 uv = surfaceUv(pl);

    float cloud = cloudAt(uClouds, uv);

    float sunVis = 1.0;
    if (uEclipse.x > 0.5) {
        vec3 m = uMoonPosW - vPosW;
        float dm = length(m);
        sunVis = discVisible(uEclipse.z, asin(clamp(uEclipse.y / dm, 0.0, 1.0)), angleBetween(m / dm, L));
    }

    // Sunlit tops: white by day; gold, red, then dark as the Sun sets on them.
    vec3 sunC = atmSunTint(CLOUD_TOP, mu);
    float wrapL = pow(clamp((mu + 0.25) / 1.25, 0.0, 1.0), 0.8);
    vec3 col = sunC * wrapL * uSunE * 0.9 * sunVis;

    // Unlit deck: faint, cool and desaturated (moonlight / airglow), never brown.
    float dark = 1.0 - smoothstep(-0.12, 0.0, mu);
    col += vec3(0.010, 0.013, 0.020) * dark;

    // City light scattered up through the deck (blurred: clouds diffuse it).
    float nightW = 1.0 - smoothstep(-0.12, 0.03, mu);
    vec3 below = pow(textureLod(uNight, uv, 3.5).rgb, vec3(1.0, 1.1, 1.35)) * vec3(1.0, 0.8, 0.55);
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

    // Thicker along slant paths (capped: the deck is thin).
    float a = clamp(cloud * 0.95, 0.0, 0.98);
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
