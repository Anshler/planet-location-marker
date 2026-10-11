/**
 * Earth surface shader (SPEC §E.2). Linear HDR output; only the ocean glint and
 * city lights are meant to exceed the 0.9 bloom threshold.
 *
 * Lighting shares the atmosphere model (atmosphere.glsl.js): low sunlight is
 * tinted by the real transmittance of its path, and aerial perspective is
 * extinction plus in-scatter from the same constants as the limb, so the disc
 * edge meets the atmosphere's base without a seam and the terminator band
 * matches the sunset ring.
 *
 * Tier switches that only change which texture feeds a slot (ocean mask, cloud
 * source) are uniforms, so a texture and its interpretation swap together the
 * moment the texture arrives, with no recompile. Features that add texture
 * fetches (BUMP, CLOUD_SHADOWS) are #defines set once per tier.
 */
import { COMMON, SURFACE_FRAG } from './common.glsl.js';
import { ATMO_MODEL } from './atmosphere.glsl.js';

/** Shared by the Earth and the cloud shell (both are spheres in the Earth group). */
export const SURFACE_VERTEX = /* glsl */ `
varying vec3 vPosL;
varying vec3 vPosW;
varying vec3 vNw;

void main() {
    vPosL = position;
    vec4 pw = modelMatrix * vec4(position, 1.0);
    vPosW = pw.xyz;
    vNw = mat3(modelMatrix) * normal;
    gl_Position = projectionMatrix * viewMatrix * pw;
}
`;

/**
 * Cloud density lookup shared by the surface and the cloud shell. Needs the
 * uniforms uCloudMode (0 none, 1 clouds1k: alpha carries density, 2 brc4k:
 * blue channel) and uCloudShift (eastward drift in u).
 *
 * clouds1k is only 1024 px around the globe (39 km texels), so magnified
 * lookups use a 4-tap B-spline filter instead of bilinear (no diamond/blocky
 * texels up close). Both maps' smeared polar caps are tapered out.
 */
export const CLOUD_LOOKUP = /* glsl */ `
vec4 pcCubicW(float v) {
    vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
    vec4 s = n * n * n;
    float x = s.x;
    float y = s.y - 4.0 * s.x;
    float z = s.z - 4.0 * s.y + 6.0 * s.x;
    return vec4(x, y, z, 6.0 - x - y - z) * (1.0 / 6.0);
}

// Cubic B-spline sample of mip 0 from 4 bilinear taps.
vec4 pcTextureBSpline(sampler2D tex, vec2 uv) {
    vec2 size = vec2(textureSize(tex, 0));
    vec2 st = uv * size - 0.5;
    vec2 f = fract(st);
    st -= f;
    vec4 xc = pcCubicW(f.x), yc = pcCubicW(f.y);
    vec4 c = st.xxyy + vec2(-0.5, 1.5).xyxy;
    vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
    vec4 o = (c + vec4(xc.yw, yc.yw) / s) / size.xxyy;
    vec4 t0 = textureLod(tex, o.xz, 0.0), t1 = textureLod(tex, o.yz, 0.0);
    vec4 t2 = textureLod(tex, o.xw, 0.0), t3 = textureLod(tex, o.yw, 0.0);
    float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
    return mix(mix(t3, t2, sx), mix(t1, t0, sx), sy);
}

float cloudAt(sampler2D tex, vec2 uv) {
    if (uCloudMode < 0.5) return 0.0;
    vec2 st = vec2(uv.x - uCloudShift, uv.y);
    // Both cloud maps converge into radial streaks at the poles: taper them out.
    float polar = 1.0 - smoothstep(0.84, 0.95, abs(uv.y - 0.5) * 2.0);
    if (uCloudMode < 1.5) {
        vec2 sz = vec2(textureSize(tex, 0));
        vec2 dx = dFdx(st) * sz, dy = dFdy(st) * sz;
        float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
        vec4 c = mix(pcTextureBSpline(tex, st), textureLod(tex, st, max(lod, 0.0)), smoothstep(-0.5, 0.5, lod));
        return c.a * max(c.r, max(c.g, c.b)) * polar;
    }
    return smoothstep(0.2, 1.0, texture(tex, st).b) * polar;
}
`;

const vertex = SURFACE_VERTEX;

const fragment = /* glsl */ `
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uMask;
uniform sampler2D uClouds;

uniform vec3 uSunDirW;      // world, unit, toward the Sun
uniform vec3 uSunDirL;      // Earth-local (geometry frame)
uniform vec3 uPoleW;        // world direction of the geographic north pole
uniform float uSunE;        // sunlight scale (linear HDR)
uniform float uLightsGain;  // city lights gain (HDR, blooms)
uniform float uBumpScale;
uniform float uGlintGain;
uniform float uHazeE;       // in-scatter radiance scale (matches the atmosphere shell)

uniform float uMaskMode;    // 0 derived from day map, 1 specular (white = water), 2 roughness (brc4k.g)
uniform vec2 uDerivedWin;   // smoothstep window on (b - r) for the derived mask, per day map
uniform float uDayGain;     // per-map albedo gain (the 2k map is darker than the 4k one)
uniform float uBumpOn;      // 1 when uMask is brc4k (height in .r)
uniform float uCloudMode;
uniform float uCloudShift;
uniform float uAtmo;        // aerial perspective on/off (atmosphere layer)

uniform vec4 uEclipse;      // (on, moon radius ER, sun angular radius rad, _)
uniform vec3 uMoonPosW;

uniform vec4 uFoot;         // (dir.xyz world, on)
uniform vec3 uFootColor;
uniform float uFootK;       // dot threshold of the footprint edge (1/distance for the Moon, else 0)

uniform vec3 uSub[9];
uniform vec3 uSubCol[9];
uniform float uSubOn;

uniform float uFade;        // 1 - skyBlend

varying vec3 vPosL;
varying vec3 vPosW;
varying vec3 vNw;

${COMMON}
${SURFACE_FRAG}
${ATMO_MODEL}
${CLOUD_LOOKUP}

void main() {
    vec3 pl = normalize(vPosL);
    vec3 Ng = normalize(vNw);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 L = normalize(uSunDirW);
    float mu = dot(Ng, L);

    vec2 uvRaw = localDirToUv(pl);
    vec2 uv = seamlessUv(uvRaw);

    vec3 albedoRaw = texture(uDay, uv).rgb;
    vec3 albedo = albedoRaw * uDayGain;
    vec4 maskTex = texture(uMask, uv);

    // --- ocean mask (derived from the raw map: windows were fitted on it) ---
    float lum = dot(albedoRaw, vec3(0.2126, 0.7152, 0.0722));
    float derived = smoothstep(uDerivedWin.x, uDerivedWin.y, albedoRaw.b - albedoRaw.r)
                  * (1.0 - smoothstep(0.25, 0.45, lum));   // bright = ice or cloud, not water
    float ocean = uMaskMode < 0.5 ? derived
                : (uMaskMode < 1.5 ? maskTex.r : 1.0 - smoothstep(0.25, 0.45, maskTex.g));

    float cloud = cloudAt(uClouds, uv);

    // --- tangent frame (world), robust at the poles -----------------------
    vec3 eW = cross(uPoleW, Ng);
    float eLen = length(eW);
    eW = eLen > 1e-5 ? eW / eLen : normalize(cross(vec3(1.0, 0.0, 0.0), Ng));
    vec3 nW = cross(Ng, eW);

    // --- bump (high tier): height = brc4k.r, central differences ----------
    vec3 N = Ng;
#ifdef BUMP
    if (uBumpOn > 0.5) {
        vec2 texel = 1.0 / vec2(textureSize(uMask, 0));
        vec4 sE = texture(uMask, uv + vec2(texel.x, 0.0));
        vec4 sW = texture(uMask, uv - vec2(texel.x, 0.0));
        vec4 sN = texture(uMask, uv + vec2(0.0, texel.y));
        vec4 sS = texture(uMask, uv - vec2(0.0, texel.y));
        vec2 grad = vec2(sE.r - sW.r, sN.r - sS.r);
        // Water is flat, and the height map outlines every coast with a one-texel
        // ridge: keep relief to land interiors (roughness .g ~ 1 on land, ~ 0 on water).
        float land = smoothstep(0.25, 0.45, min(min(sE.g, sW.g), min(sN.g, sS.g)));
        // The polar rows of the height map are smeared JPEG noise: fade relief out above ~70 deg.
        float polar = 1.0 - smoothstep(0.93, 0.985, abs(pl.y));
        grad *= land * polar / max(1.0, length(grad) * 5.0);   // clamp outliers to |grad| <= 0.2
        N = normalize(Ng - uBumpScale * (grad.x * eW + grad.y * nW));
    }
#endif

    // --- Sun visibility (Moon's shadow during a solar eclipse) -----------
    float sunVis = 1.0;
    if (uEclipse.x > 0.5) {
        vec3 m = uMoonPosW - vPosW;
        float dm = length(m);
        sunVis = discVisible(uEclipse.z, asin(clamp(uEclipse.y / dm, 0.0, 1.0)), angleBetween(m / dm, L));
    }

    // --- cloud shadow (high tier): sample the cloud layer toward the Sun ---
    float csh = 0.0;
#ifdef CLOUD_SHADOWS
    {
        vec3 Ls = normalize(uSunDirL);
        float c = max(dot(Ls, pl), 0.2);
        vec3 ps = normalize(pl + (Ls - pl * dot(Ls, pl)) * (0.006 / c));
        vec2 duv = localDirToUv(ps) - uvRaw;
        duv.x -= floor(duv.x + 0.5);            // keep the offset continuous across the dateline
        csh = cloudAt(uClouds, uv + duv) * smoothstep(-0.05, 0.1, mu);
    }
#endif

    // --- direct sunlight, reddened by its real path length at low Sun ----
    vec3 sunT = atmSunTint(0.0, mu);
    float NoL = max(dot(N, L), 0.0);
    vec3 col = albedo * sunT * NoL * uSunE * sunVis * (1.0 - 0.55 * csh);

    // --- skylight: a little blue fill by day, a violet afterglow past sunset ---
    float sky = mu > 0.0 ? 1.0 : exp(mu / 0.03);
    col += albedo * mix(vec3(0.45, 0.32, 0.50), vec3(0.30, 0.45, 0.75), smoothstep(-0.02, 0.2, mu)) * sky * 0.035 * sunVis;

    // --- night: faint, cool, desaturated "moonlit" ground (ice compressed, so
    //     snowfields do not glow as hard-edged ghosts in polar night) ---------
    col += mix(vec3(lum), albedo, 0.35) / (1.0 + 2.5 * lum) * vec3(0.55, 0.75, 1.3) * 0.008;

    // --- ocean sun glint (GGX): a hot core inside a broad wind-roughened sheen ---
    vec3 hv = L + V;
    vec3 H = hv * inversesqrt(max(dot(hv, hv), 1e-12));   // normalize(), finite even when V == -L
    float NoLg = max(dot(Ng, L), 0.0);
    float NoV = max(dot(Ng, V), 1e-3);
    float NoH = max(dot(Ng, H), 0.0);
    float VoH = max(dot(V, H), 0.0);
    const float A_CORE = 0.045;
    const float A_SHEEN = 0.20;
    float spec = 3.2 * D_GGX(NoH, A_CORE) * V_SmithFast(NoV, NoLg, A_CORE)
               + 6.5 * D_GGX(NoH, A_SHEEN) * V_SmithFast(NoV, NoLg, A_SHEEN);
    float glint = min(spec * F_Schlick(0.02, VoH) * NoLg * uSunE * uGlintGain, 6.0);
    col += sunT * ocean * (1.0 - cloud) * (1.0 - csh) * sunVis * glint;

    // --- city lights, night side only, dimmed under clouds (HDR: they bloom) ---
    float nightW = 1.0 - smoothstep(-0.12, 0.03, mu);
    // In the Moon's umbra it is dark enough for cities to show through.
    nightW = max(nightW, (1.0 - sunVis) * (1.0 - sunVis) * 0.8);
    vec3 lights = pow(texture(uNight, uv).rgb, vec3(1.0, 1.1, 1.35)) * vec3(1.0, 0.85, 0.62) * uLightsGain;
    col += lights * nightW * (1.0 - 0.8 * cloud);

    // --- aerial perspective: extinction + in-scatter, clearer than life at the centre ---
    if (uAtmo > 0.5) {
        float edge = 1.0 - NoV;
        vec3 Tv, Si;
        atmAerial(Ng, V, L, mix(0.15, 1.0, edge * edge * edge), uHazeE, Tv, Si);
        col = col * Tv + Si * sunVis;
        col += vec3(0.010, 0.016, 0.032) * edge * edge * edge * edge;   // keep the night limb's shape
    }

    // --- visibility footprint of the selected body: a crisp horizon line
    //     (pixel-stable) with a tint that glows just inside it and fades inward ---
    if (uFoot.w > 0.5) {
        float k = dot(Ng, uFoot.xyz) - uFootK;
        float w = max(fwidth(k), 1e-6);
        float edgeK = max(exp(-k * k / 0.00002), exp(-k * k / (2.25 * w * w)));
        float inside = smoothstep(-w, w, k);
        col += uFootColor * (inside * (0.018 + 0.09 * exp(-max(k, 0.0) / 0.07)) + 0.5 * edgeK);
    }

    // --- sub-point dots: about 4 px when far, about 50 km when close ---
    if (uSubOn > 0.5) {
        float pa = max(length(fwidth(Ng)), 1e-6);   // radians per pixel on the surface
        float r = max(0.008, 3.5 * pa);
        for (int i = 0; i < 9; i++) {
            float th = angleBetween(Ng, uSub[i]);
            float dotK = 1.0 - smoothstep(r - 1.5 * pa, r, th);
            float halo = exp(-th * th / (r * r * 6.0)) * 0.25;
            col += uSubCol[i] * (dotK * 2.0 + halo);
        }
    }

    col *= uFade;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/** Earth surface ShaderMaterial sources. */
export const EARTH_SHADER = { vertex, fragment };
export { vertex, fragment };
