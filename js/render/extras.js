/**
 * Extra objects at infinity (astro/extras.js): the glyphs of everything the registry lists, and
 * the reticle around a selected one. A render module (RenderModule contract) plus `pickCandidates`.
 *
 * - glyph 'star' (guest stars): a point set drawn with the star field's own material
 *   (render/sky.js `starMaterial`; a copy on the same uniforms and program), so a supernova
 *   twinkles, reddens, streaks and fades into the twilight exactly like the catalogue stars; its
 *   magnitude is refilled from snap.extras.
 * - glyph 'marker' (spacecraft): a small hollow diamond in the object's colour: things far too
 *   faint to see still need a place on the sky.
 * - glyph 'coma' (comets) is drawn by render/comets.js; 'none' (a catalogue star) by its own layer.
 * - The selected extra gets a ring (the bodies' reticle is only for the nine).
 *
 * A meta `layer` (e.g. 'stars', 'spacecraft') must be on for a glyph to be drawn or picked.
 * Fixed buffers, allocated once (R5); the slot tables are rebuilt only when the registry changes.
 * Both point sets hide through their own materials and stay in the scene graph: three uploads a
 * geometry the first time it projects the object, so one hidden until a guest star's outburst
 * (or a spacecraft's launch) came round in a time-lapse would upload its buffers then.
 *
 * @module render/extras
 */
import * as THREE from 'three';
import { INFINITY_VERT_CHUNK } from './shaders/sky.glsl.js';
import { bvToRgb, liftByRefraction } from '../astro/photometry.js';

/** Most extra objects drawn at once (guest stars + markers); more are skipped. */
const CAP = 64;
const MARK_PX = 9;
const RETICLE_PX = 30;
/** A guest star's B−V (a supernova near maximum is about white). */
const GUEST_BV = 0.25;

const MARK_VERT = /* glsl */ `
uniform float uPx;
attribute vec3 aColor;
attribute float aStyle;
attribute float aSize;
varying vec3 vColor;
varying float vStyle;
${INFINITY_VERT_CHUNK}
void main() {
    vColor = aColor;
    vStyle = aStyle;
    gl_PointSize = aSize * uPx;
    gl_Position = aSize > 0.0 ? infinityClip(normalize(position)) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const MARK_FRAG = /* glsl */ `
uniform float uAlpha;
varying vec3 vColor;
varying float vStyle;
void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float a;
    if (vStyle < 0.5) {
        // A hollow diamond (a spacecraft's place).
        float d = abs(p.x) + abs(p.y);
        a = smoothstep(0.50, 0.62, d) * (1.0 - smoothstep(0.84, 0.97, d));
    } else {
        // The selection ring.
        float r = length(p);
        a = smoothstep(0.76, 0.82, r) * (1.0 - smoothstep(0.90, 0.97, r));
    }
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * (a * uAlpha), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/** sRGB hex → linear RGB triple. */
function hexLinear(hex, out) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    const c = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [220, 220, 230];
    for (let k = 0; k < 3; k++) {
        const v = c[k] / 255;
        out[k] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return out;
}

/**
 * Creates the extras layer.
 * @param {object} rc RenderContext
 * @param {{extras:any, sky?:any}} deps the registry; the sky module (its star material)
 * @returns {object} RenderModule & {pickCandidates():Array<{id:string, dirS:Float64Array}>}
 */
export function createExtrasLayer(rc, { extras, sky = null } = {}) {
    const group = new THREE.Group();
    group.name = 'extras';

    // --- guest stars: the star field's material ------------------------------------------------
    const gPos = new Float32Array(CAP * 3);
    const gMag = new Float32Array(CAP).fill(99);
    const gCol = new Float32Array(CAP * 3);
    const gGeom = new THREE.BufferGeometry();
    const gPosAttr = new THREE.BufferAttribute(gPos, 3);
    const gMagAttr = new THREE.BufferAttribute(gMag, 1);
    gGeom.setAttribute('position', gPosAttr);
    gGeom.setAttribute('aMag', gMagAttr);
    gGeom.setAttribute('aColor', new THREE.BufferAttribute(gCol, 3));
    gGeom.setDrawRange(0, 0);
    const starMat = sky && sky.starMaterial ? sky.starMaterial : null;
    // Its own copy of the star material, on the same uniform objects (and so the same program), so
    // that it can hide through its material without hiding the star field.
    const guestMat = starMat ? starMat.clone() : null;
    if (guestMat) guestMat.uniforms = starMat.uniforms;
    const guests = guestMat ? new THREE.Points(gGeom, guestMat) : null;
    if (guests) {
        guests.name = 'extras.guests';
        guests.frustumCulled = false;
        guests.matrixAutoUpdate = false;
        guests.renderOrder = -69;
        group.add(guests);
    }
    const gRgb = bvToRgb(GUEST_BV, [1, 1, 1]);

    // --- markers and the reticle ----------------------------------------------------------------
    const mPos = new Float32Array((CAP + 1) * 3);
    const mCol = new Float32Array((CAP + 1) * 3);
    const mStyle = new Float32Array(CAP + 1);
    const mSize = new Float32Array(CAP + 1);
    const mGeom = new THREE.BufferGeometry();
    const mPosAttr = new THREE.BufferAttribute(mPos, 3);
    const mColAttr = new THREE.BufferAttribute(mCol, 3);
    const mSizeAttr = new THREE.BufferAttribute(mSize, 1);
    const mStyleAttr = new THREE.BufferAttribute(mStyle, 1);
    mGeom.setAttribute('position', mPosAttr);
    mGeom.setAttribute('aColor', mColAttr);
    mGeom.setAttribute('aStyle', mStyleAttr);
    mGeom.setAttribute('aSize', mSizeAttr);
    const upS = new THREE.Vector3(0, 1, 0);
    const mUniforms = { uPx: { value: 1 }, uAlpha: { value: 0.85 }, uRefrUp: { value: upS }, uRefrK: { value: 0 } };
    const mMat = new THREE.ShaderMaterial({
        name: 'extras.marks', uniforms: mUniforms, vertexShader: MARK_VERT, fragmentShader: MARK_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    const marks = new THREE.Points(mGeom, mMat);
    marks.name = 'extras.marks';
    marks.frustumCulled = false;
    marks.matrixAutoUpdate = false;
    marks.renderOrder = 45;
    group.add(marks);

    // --- slot tables (rebuilt when the registry changes) ---------------------------------------
    /** @type {{id:string, glyph:string, layer:string|null, rgb:number[]}[]} */
    let slots = [];
    let builtVersion = -1;
    function rebuildSlots() {
        builtVersion = extras ? extras.version : 0;
        slots = (extras ? extras.ids() : []).map((id) => {
            const m = extras.meta(id);
            return { id, glyph: m?.glyph ?? 'none', layer: m?.layer ?? null, rgb: hexLinear(m?.color, [0, 0, 0]) };
        });
    }
    rebuildSlots();
    const offChange = extras && typeof extras.onChange === 'function' ? extras.onChange(rebuildSlots) : null;

    let layers = {};
    let selection = null;
    let skyBlend = 0;
    let lastSnap = null;
    const pickDirs = Array.from({ length: CAP }, () => new Float64Array(3));
    const pickList = [];
    const pickPool = Array.from({ length: CAP }, (_, i) => ({ id: '', dirS: pickDirs[i] }));

    const layerOn = (s) => !s.layer || layers[s.layer] === true;

    function apply(snap) {
        if (!snap) return;
        lastSnap = snap;
        if (extras && builtVersion !== extras.version) rebuildSlots();
        const xs = snap.extras;
        const up = snap.observer?.upS;
        if (up) upS.set(up[0], up[1], up[2]);
        let ng = 0, nm = 0;
        let sel = -1;
        for (let i = 0; i < slots.length && xs && i < xs.length; i++) {
            const s = slots[i];
            const st = xs[i];
            if (!st || st.id !== s.id) continue;
            // A satellite ('sat') is drawn, ringed and picked by render/satellites.js, frame by frame.
            if (s.glyph === 'sat') continue;
            const shown = st.present && layerOn(s);
            if (s.id === selection && st.present) sel = i;
            if (!shown) continue;
            const d = st.dirS;
            if (s.glyph === 'star' && guests && ng < CAP) {
                gPos[ng * 3] = d[0]; gPos[ng * 3 + 1] = d[1]; gPos[ng * 3 + 2] = d[2];
                gMag[ng] = Number.isFinite(st.mag) ? st.mag : 99;
                gCol[ng * 3] = gRgb[0]; gCol[ng * 3 + 1] = gRgb[1]; gCol[ng * 3 + 2] = gRgb[2];
                ng++;
            } else if (s.glyph === 'marker' && nm < CAP) {
                mPos[nm * 3] = d[0]; mPos[nm * 3 + 1] = d[1]; mPos[nm * 3 + 2] = d[2];
                mCol[nm * 3] = s.rgb[0]; mCol[nm * 3 + 1] = s.rgb[1]; mCol[nm * 3 + 2] = s.rgb[2];
                mStyle[nm] = 0;
                mSize[nm] = MARK_PX;
                nm++;
            }
        }
        if (sel >= 0) {
            const d = xs[sel].dirS;
            const c = slots[sel].rgb;
            mPos[nm * 3] = d[0]; mPos[nm * 3 + 1] = d[1]; mPos[nm * 3 + 2] = d[2];
            mCol[nm * 3] = 0.4 + 0.6 * c[0]; mCol[nm * 3 + 1] = 0.4 + 0.6 * c[1]; mCol[nm * 3 + 2] = 0.4 + 0.6 * c[2];
            mStyle[nm] = 1;
            mSize[nm] = RETICLE_PX;
            nm++;
        }
        // Hidden sets are still projected every frame: re-upload only what is drawn.
        gGeom.setDrawRange(0, ng);
        if (ng > 0) {
            gPosAttr.needsUpdate = true;
            gMagAttr.needsUpdate = true;
            gGeom.attributes.aColor.needsUpdate = true;
        }
        mGeom.setDrawRange(0, nm);
        if (nm > 0) {
            mPosAttr.needsUpdate = true;
            mColAttr.needsUpdate = true;
            mSizeAttr.needsUpdate = true;
            mStyleAttr.needsUpdate = true;
        }
        if (guestMat) guestMat.visible = ng > 0;
        mMat.visible = nm > 0;
    }

    return {
        object3d: group,
        apply,
        update(fi) {
            if (!fi) return;
            if (Number.isFinite(fi.skyBlend)) skyBlend = fi.skyBlend;
            mUniforms.uRefrK.value = Math.max(0, Math.min(1, skyBlend));
            mUniforms.uPx.value = Math.max(1, rc?.dpr || 1);
        },
        setLayers(l) { if (l) layers = { ...l }; if (lastSnap) apply(lastSnap); },
        setSelection(id) { selection = id || null; if (lastSnap) apply(lastSnap); },
        setViewMode(_mode, blend) { if (Number.isFinite(blend)) skyBlend = blend; },
        setQuality() {},
        /** Drawn extras (and the selected one) at their drawn (refraction-lifted) directions. */
        pickCandidates() {
            pickList.length = 0;
            const xs = lastSnap?.extras;
            const up = lastSnap?.observer?.upS;
            if (!xs) return pickList;
            for (let i = 0; i < slots.length && i < xs.length && pickList.length < CAP; i++) {
                const s = slots[i];
                const st = xs[i];
                if (!st || !st.present || st.id !== s.id || s.glyph === 'sat') continue;
                if (!(s.id === selection || (s.glyph !== 'none' && layerOn(s)))) continue;
                const c = pickPool[pickList.length];
                c.id = s.id;
                if (up) liftByRefraction(st.dirS, up, skyBlend, c.dirS);
                else c.dirS.set(st.dirS);
                pickList.push(c);
            }
            return pickList;
        },
        dispose() {
            offChange?.();
            gGeom.dispose();
            mGeom.dispose();
            mMat.dispose();
            guestMat?.dispose();
        },
    };
}
