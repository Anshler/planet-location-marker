/**
 * Earth surface shader (SPEC §E.2). Linear HDR output; only the ocean glint, the
 * moonglint's core, city lights and a storm-level aurora are meant to exceed the 0.9
 * bloom threshold. The night side is moonlit by the Moon's phase (docs/ASTRONOMY.md §6b),
 * city lights are filtered for close zoom, and the face-on aurora (shaders/aurora.glsl.js)
 * is added over the haze.
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
import { AURORA_CHUNK } from './aurora.glsl.js';

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
 * uniforms uCloudMode (0 none, 1 clouds2k or clouds8k: grey, 2 brc4k: blue channel) and
 * uCloudShift (eastward drift in u).
 *
 * clouds2k is brc4k's blue channel at half size (scripts/build-textures.mjs),
 * so both modes read the same cloud field through the same density curve and
 * every tier shows the same weather. At 2048 px around the globe (20 km
 * texels), magnified lookups use a 4-tap B-spline filter instead of bilinear
 * (no diamond/blocky texels up close). The smeared polar caps are tapered out.
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

// Cloud cover from the stored value (identical for both cloud maps).
float cloudDensity(float v) {
    return smoothstep(0.2, 1.0, v);
}

float cloudAt(sampler2D tex, vec2 uv) {
    if (uCloudMode < 0.5) return 0.0;
    vec2 st = vec2(uv.x - uCloudShift, uv.y);
    // The cloud field converges into radial streaks at the poles: taper it out.
    float polar = 1.0 - smoothstep(0.84, 0.95, abs(uv.y - 0.5) * 2.0);
    if (uCloudMode < 1.5) {
        vec2 sz = vec2(textureSize(tex, 0));
        vec2 dx = dFdx(st) * sz, dy = dFdy(st) * sz;
        float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
        float v = mix(pcTextureBSpline(tex, st).r, textureLod(tex, st, max(lod, 0.0)).r, smoothstep(-0.5, 0.5, lod));
        return cloudDensity(v) * polar;
    }
    return cloudDensity(texture(tex, st).b) * polar;
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

uniform float uMaskMode;    // 0 derived from day map, 1 roughness in .g (brc4k, or its grey 2k copy)
uniform float uBumpOn;      // 1 when uMask is brc4k (height in .r)
uniform float uCloudMode;
uniform float uCloudShift;
uniform float uAtmo;        // aerial perspective on/off (atmosphere layer)

uniform vec4 uEclipse;      // (on, moon radius ER, sun angular radius rad, _)
uniform vec3 uMoonPosW;
uniform float uMoonK;       // moonlight: the Moon's illuminated fraction x its sunlit share (lunar eclipses)

uniform vec4 uFoot;        // (dir.xyz world, on)
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
${AURORA_CHUNK}

// Moonlight scale (linear HDR) on the face toward a full Moon. Physical moonlight is ~4e-6 of
// sunlight; this is perceptual, like the clearer-than-life haze. NIGHT_FLOOR: starlight and airglow.
const float MOON_E = 0.02;
const float NIGHT_FLOOR = 0.002;

// City lights at uv. Magnified, a 4-tap B-spline replaces bilinear (no squares or creases), on the
// 4096 and the 8192 map alike (the filter follows the bound map's own texel size). Below lod -1.5
// an Earth-fixed point field (2 x 2 cells per texel, one jittered point each, normalised so every
// cell keeps its energy) breaks the blobs into grain no finer than a pixel, and only once a cell
// spans several pixels; it is invented detail, so it is faint and gone by lod -1.5. Clipped cores
// (max channel near 1) get a pseudo-HDR boost so metropolis centres bloom harder than suburbs.
vec3 nightLights(vec2 uv) {
    vec2 nsz = vec2(textureSize(uNight, 0));
    vec2 ndx = dFdx(uv) * nsz, ndy = dFdy(uv) * nsz;
    float nLod = 0.5 * log2(max(max(dot(ndx, ndx), dot(ndy, ndy)), 1e-8));
    float pxc = 2.0 * sqrt(max(max(dot(ndx, ndx), dot(ndy, ndy)), 1e-12));   // a pixel, in grain cells
    vec3 raw = texture(uNight, uv).rgb;
    if (nLod < 0.5) raw = mix(pcTextureBSpline(uNight, uv).rgb, raw, smoothstep(-0.5, 0.5, nLod));
    float maxc = max(raw.r, max(raw.g, raw.b));
    vec3 lights = pow(max(raw, vec3(0.0)), vec3(1.0, 1.1, 1.35)) * vec3(1.0, 0.85, 0.62) * uLightsGain;
    lights *= 1.0 + 1.5 * smoothstep(0.85, 1.0, maxc);
    float sig = max(pxc, 0.12);   // point radius in cells: never under a pixel
    float vis = (1.0 - smoothstep(-3.0, -1.5, nLod)) * (1.0 - smoothstep(0.3, 0.5, sig));
    if (vis > 0.0) {
        vec2 st = vec2(fract(uv.x), uv.y) * nsz * 2.0;
        float wrapW = nsz.x * 2.0;
        vec2 cell = floor(st);
        float acc = 0.0;
        for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
                vec2 c = cell + vec2(float(i), float(j));
                vec2 cw = vec2(mod(c.x, wrapW), c.y);
                vec2 d = c + 0.15 + 0.7 * vec2(hash12(cw), hash12(cw + 17.31)) - st;
                acc += exp(-dot(d, d) / (2.0 * sig * sig));
            }
        }
        lights *= mix(1.0, min(acc / (2.0 * PI * sig * sig), 4.0), 0.5 * vis);
    }
    return lights;
}

void main() {
    vec3 pl = normalize(vPosL);
    vec3 Ng = normalize(vNw);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 L = normalize(uSunDirW);
    float mu = dot(Ng, L);

    vec2 uvRaw = localDirToUv(pl);
    vec2 uv = seamlessUv(uvRaw);

    // Both day maps are the same image (day2k is day4k at half size), so they share
    // one colour and one derived-mask window.
    vec3 albedo = texture(uDay, uv).rgb;
    vec4 maskTex = texture(uMask, uv);

    // --- ocean mask: roughness ~ 0 is water. Until the mask loads, blue-over-red water
    //     from the day map (window fitted against the mask). That stand-in runs on chroma,
    //     which lossy maps store at half resolution, so it misses small islands. ---
    float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    float derived = smoothstep(0.02, 0.10, albedo.b - albedo.r)
                  * (1.0 - smoothstep(0.25, 0.45, lum));   // bright = ice or cloud, not water
    float ocean = uMaskMode < 0.5 ? derived : 1.0 - smoothstep(0.25, 0.45, maskTex.g);

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
        float c0 = cloudAt(uClouds, uv + duv);
#ifdef CLOUD_SHADOW_SOFT
        // Max tier: four more taps 1.5 texels around it soften the shadow's edge (5 taps).
        vec2 px = 1.5 / vec2(textureSize(uClouds, 0));
        float ring = cloudAt(uClouds, uv + duv + vec2(px.x, 0.0)) + cloudAt(uClouds, uv + duv - vec2(px.x, 0.0))
                   + cloudAt(uClouds, uv + duv + vec2(0.0, px.y)) + cloudAt(uClouds, uv + duv - vec2(0.0, px.y));
        c0 = 0.5 * c0 + 0.125 * ring;
#endif
        csh = c0 * smoothstep(-0.05, 0.1, mu);
    }
#endif

    // --- direct sunlight, reddened by its real path length at low Sun ----
    vec3 sunT = atmSunTint(0.0, mu);
    float NoL = max(dot(N, L), 0.0);
    vec3 col = albedo * sunT * NoL * uSunE * sunVis * (1.0 - 0.55 * csh);

    // --- skylight: a little blue fill by day, a violet afterglow past sunset ---
    float sky = mu > 0.0 ? 1.0 : exp(mu / 0.03);
    col += albedo * mix(vec3(0.45, 0.32, 0.50), vec3(0.30, 0.45, 0.75), smoothstep(-0.02, 0.2, mu)) * sky * 0.035 * sunVis;

    // --- night: moonlight on the hemisphere facing the Moon (by its phase; dimmed in a lunar
    //     eclipse) over a faint starlight floor. Cool and desaturated, ice compressed, so
    //     snowfields do not glow as hard-edged ghosts in polar night -----------------------
    vec3 M = normalize(uMoonPosW - vPosW);
    float NoM = max(dot(N, M), 0.0);
    col += mix(vec3(lum), albedo, 0.35) / (1.0 + 2.5 * lum) * vec3(0.55, 0.75, 1.3) * (NIGHT_FLOOR + MOON_E * uMoonK * NoM);

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

    // --- city lights, night side only, dimmed under clouds (HDR: they bloom). A per-cell jitter
    //     (±0.015 in mu, ~20 km cells) switches them on progressively across the terminator ---
    float jn = (hash12(floor(vec2(fract(uv.x), uv.y) * vec2(2048.0, 1024.0))) - 0.5) * 0.03;
    float nightW = 1.0 - smoothstep(-0.12 + jn, 0.03 + jn, mu);
    // In the Moon's umbra it is dark enough for cities to show through.
    nightW = max(nightW, (1.0 - sunVis) * (1.0 - sunVis) * 0.8);
    col += nightLights(uv) * nightW * (1.0 - 0.8 * cloud);

#ifdef MOON_GLINT
    // --- moonglint: the Moon's silver path on dark water (sheen lobe plus a soft core) ---
    if (uMoonK > 0.0) {
        vec3 hm = M + V;
        vec3 Hm = hm * inversesqrt(max(dot(hm, hm), 1e-12));
        float NoLm = max(dot(Ng, M), 0.0);
        float NoHm = max(dot(Ng, Hm), 0.0);
        float specM = 0.8 * D_GGX(NoHm, 0.09) * V_SmithFast(NoV, NoLm, 0.09)
                    + 6.5 * D_GGX(NoHm, A_SHEEN) * V_SmithFast(NoV, NoLm, A_SHEEN);
        float mg = min(specM * F_Schlick(0.02, max(dot(V, Hm), 0.0)) * NoLm, 2.0);
        col += vec3(0.75, 0.85, 1.05) * (mg * uMoonK * 0.6 * ocean * nightW * (1.0 - cloud));
    }
#endif

    // --- aerial perspective: extinction + in-scatter, clearer than life at the centre ---
    if (uAtmo > 0.5) {
        float edge = 1.0 - NoV;
        vec3 Tv, Si;
        atmAerial(Ng, V, L, mix(0.15, 1.0, edge * edge * edge), uHazeE, Tv, Si);
        col = col * Tv + Si * sunVis;
        col += vec3(0.010, 0.016, 0.032) * edge * edge * edge * edge;   // keep the night limb's shape
    }

    // --- aurora: the modelled oval seen from above (shaders/aurora.glsl.js), over the haze ---
    col += auroraFace(Ng, V, L);

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
