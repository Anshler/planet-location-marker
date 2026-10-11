#!/usr/bin/env node
// Lists / stages exactly the files that make up the deployed site.
//
//   node scripts/stage-site.mjs <outDir>     copy the site into <outDir> (used by pages.yml)
//   node scripts/stage-site.mjs --list       print the file list with sizes
//
// Everything in the repo ships EXCEPT development material (SPEC §C.4): test/, scripts/,
// docs/, data/raw/, .github/, node_modules/, graphify-out/ (at any depth), .claude/, plus
// .git/, .scratch/, dotfiles (but .nojekyll), package*.json and CLAUDE.md.
// scripts/check-size.mjs measures the same list, so the 12 MB staging budget is real.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Top-level (or nested, for data/raw) paths that never ship. */
export const EXCLUDED_PATHS = ['test', 'scripts', 'docs', 'data/raw', '.github', 'node_modules', '.claude', '.git', '.scratch'];
/** Directory names excluded wherever they appear. */
export const EXCLUDED_DIR_NAMES = ['graphify-out', 'node_modules', '__pycache__'];
/** Root files that are development-only. */
export const EXCLUDED_ROOT_FILES = ['package.json', 'package-lock.json', 'CLAUDE.md'];
/** Dotfiles that DO ship. */
export const ALLOWED_DOTFILES = ['.nojekyll'];

/**
 * Site-relative paths (forward slashes, sorted) of every file that ships.
 * @param {string} [root]
 * @returns {string[]}
 */
export function siteFiles(root = ROOT) {
    const out = [];
    const walk = (rel) => {
        const abs = path.join(root, rel);
        for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
            const p = rel ? `${rel}/${ent.name}` : ent.name;
            if (EXCLUDED_PATHS.includes(p)) continue;
            if (ent.isDirectory()) {
                if (EXCLUDED_DIR_NAMES.includes(ent.name) || ent.name.startsWith('.')) continue;
                walk(p);
            } else if (ent.isFile()) {
                if (ent.name.startsWith('.') && !ALLOWED_DOTFILES.includes(ent.name)) continue;
                if (!rel && EXCLUDED_ROOT_FILES.includes(ent.name)) continue;
                if (/\.test\.m?js$/.test(ent.name)) continue;
                out.push(p);
            }
        }
    };
    walk('');
    return out.sort();
}

/**
 * Copies the site into `outDir` (emptied first).
 * @param {string} outDir
 * @param {string} [root]
 * @returns {{files:number, bytes:number}}
 */
export function stageSite(outDir, root = ROOT) {
    const dest = path.resolve(outDir);
    if (dest === path.resolve(root) || path.resolve(root).startsWith(dest + path.sep)) {
        throw new Error('refusing to stage into the repo root or one of its parents');
    }
    fs.rmSync(dest, { recursive: true, force: true });
    let bytes = 0;
    const files = siteFiles(root);
    for (const f of files) {
        const to = path.join(dest, f);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(root, f), to);
        bytes += fs.statSync(to).size;
    }
    return { files: files.length, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const arg = process.argv[2];
    if (!arg) {
        console.error('usage: node scripts/stage-site.mjs <outDir> | --list');
        process.exit(2);
    }
    if (arg === '--list') {
        let total = 0;
        for (const f of siteFiles()) {
            const size = fs.statSync(path.join(ROOT, f)).size;
            total += size;
            console.log(`${String(size).padStart(9)}  ${f}`);
        }
        console.log(`${String(total).padStart(9)}  total`);
    } else {
        const { files, bytes } = stageSite(arg);
        console.log(`staged ${files} files, ${(bytes / 1e6).toFixed(2)} MB → ${path.resolve(arg)}`);
    }
}
