// Module resolve hooks that give Node the page's import map (index.html): `three` and
// `three/addons/…` resolve to the vendored files, so render-side modules such as camera/rig.js can
// be loaded in unit tests. Install with `register('./helpers/three-hooks.mjs', import.meta.url)`
// before the first dynamic import of such a module.
const VENDOR = new URL('../../vendor/three/', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'three') return { url: new URL('three.module.min.js', VENDOR).href, shortCircuit: true };
    if (specifier.startsWith('three/addons/')) return { url: new URL(specifier.slice('three/'.length), VENDOR).href, shortCircuit: true };
    return nextResolve(specifier, context);
}
