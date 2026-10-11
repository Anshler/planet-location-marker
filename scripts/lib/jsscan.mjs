// Lightweight JavaScript source scanner for the repo checks (zero dependencies).
//
// One pass over the source tracks comments, string/template literals (with nested ${…}
// code) and regex literals, and produces two views with identical length and line breaks:
//   noComments — comments blanked, everything else intact (for URL scans)
//   code       — comments AND string/regex contents blanked (for identifier scans)
// It is a scanner, not a parser: good enough for hand-written ES2022 modules.

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'instanceof', 'yield', 'await']);
const PUNCT_BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const IDENT = /[A-Za-z0-9_$]/;
const BACKTICK = '`';

const blank = (ch) => (ch === '\n' || ch === '\r' ? ch : ' ');

/**
 * Splits a source file into a comment-free view and a code-only view.
 * @param {string} src
 * @returns {{noComments:string, code:string}}
 */
export function scanJs(src) {
    const nc = [];      // noComments
    const cd = [];      // code
    const stack = [];   // template nesting: brace depth at which each ${ … } returns to its template
    let depth = 0;
    let lastSig = '';   // last significant char in code ('w' = identifier/number, ')' = operand)
    let lastWord = '';  // last identifier/keyword in code
    let i = 0;
    const n = src.length;

    const emit = (ch, keepInCode = true) => {
        nc.push(ch);
        cd.push(keepInCode ? ch : blank(ch));
    };
    const emitComment = (ch) => {
        nc.push(blank(ch));
        cd.push(blank(ch));
    };
    const operand = () => {
        lastSig = ')';
        lastWord = '';
    };

    const readQuoted = (q) => {
        emit(q);
        i++;
        while (i < n && src[i] !== q && src[i] !== '\n') {   // unterminated: stop at line end
            if (src[i] === '\\' && i + 1 < n) {
                emit(src[i], false);
                i++;
            }
            emit(src[i], false);
            i++;
        }
        if (src[i] === q) {
            emit(q);
            i++;
        }
        operand();
    };

    // Reads template text (just after a backtick or a closing ${ … }) up to the closing
    // backtick (the template is then an operand) or the next ${ (code resumes).
    const readTemplate = () => {
        while (i < n) {
            const ch = src[i];
            if (ch === '\\' && i + 1 < n) {
                emit(ch, false);
                emit(src[i + 1], false);
                i += 2;
            } else if (ch === BACKTICK) {
                emit(ch);
                i++;
                operand();
                return;
            } else if (ch === '$' && src[i + 1] === '{') {
                emit('$');
                emit('{');
                i += 2;
                stack.push(depth);
                depth++;
                lastSig = '{';
                lastWord = '';
                return;
            } else {
                emit(ch, false);
                i++;
            }
        }
    };

    const readRegex = () => {
        emit('/');
        i++;
        let inClass = false;
        while (i < n && src[i] !== '\n') {
            const ch = src[i];
            if (ch === '\\' && i + 1 < n) {
                emit(ch, false);
                emit(src[i + 1], false);
                i += 2;
                continue;
            }
            if (ch === '[') inClass = true;
            else if (ch === ']') inClass = false;
            else if (ch === '/' && !inClass) break;
            emit(ch, false);
            i++;
        }
        if (src[i] === '/') {
            emit('/');
            i++;
        }
        while (i < n && /[a-z]/i.test(src[i])) {
            emit(src[i]);
            i++;
        }
        operand();
    };

    const readCodeChar = (ch) => {
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (stack.length && stack.at(-1) === depth) {   // end of a template ${ … }
                stack.pop();
                emit('}');
                i++;
                readTemplate();
                return;
            }
        }
        emit(ch);
        i++;
        if (IDENT.test(ch)) {
            lastWord = lastSig === 'w' && IDENT.test(src[i - 2] ?? '') ? lastWord + ch : ch;
            lastSig = 'w';
        } else if (!/\s/.test(ch)) {
            lastSig = ch;
            lastWord = '';
        }
    };

    while (i < n) {
        const ch = src[i];
        const next = src[i + 1];
        if (ch === '/' && next === '/') {
            while (i < n && src[i] !== '\n') emitComment(src[i++]);
        } else if (ch === '/' && next === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end < 0 ? n : end + 2;
            while (i < stop) emitComment(src[i++]);
        } else if (ch === '\'' || ch === '"') {
            readQuoted(ch);
        } else if (ch === BACKTICK) {
            emit(ch);
            i++;
            readTemplate();
        } else if (ch === '/' && (PUNCT_BEFORE_REGEX.has(lastSig) || KEYWORDS_BEFORE_REGEX.has(lastWord))) {
            readRegex();
        } else {
            readCodeChar(ch);
        }
    }
    return { noComments: nc.join(''), code: cd.join('') };
}

/**
 * Module specifiers referenced by a source file (comments ignored).
 * @param {string} src
 * @returns {{static:string[], dynamic:string[], urls:string[]}} urls: `new URL('…', import.meta.url)` targets
 */
export function findImports(src) {
    const { noComments } = scanJs(src);
    const out = { static: [], dynamic: [], urls: [] };
    const take = (re, list) => {
        for (const m of noComments.matchAll(re)) list.push(m[1]);
    };
    take(/(?:^|[;\n}])\s*import\s+(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/g, out.static);
    take(/(?:^|[;\n}])\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"\n]+)['"]/g, out.static);
    take(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, out.dynamic);
    take(/new\s+URL\s*\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g, out.urls);
    return out;
}

/**
 * 1-based line number of a character offset.
 * @param {string} src
 * @param {number} index
 * @returns {number}
 */
export function lineAt(src, index) {
    let line = 1;
    for (let k = 0; k < index && k < src.length; k++) if (src[k] === '\n') line++;
    return line;
}
