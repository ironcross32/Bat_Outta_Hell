// Inlines syngen and the per-module game scripts into BOH.html, producing
// BOH-standalone.html — a single portable file with no node_modules and no
// loose ./js/* siblings.
//
// Usage: node build.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC_HTML = path.join(__dirname, 'BOH.html');
const SYNGEN_JS = path.join(__dirname, 'node_modules', 'syngen', 'dist', 'syngen.min.js');
const JS_DIR = path.join(__dirname, 'js');
const OUT_HTML = path.join(__dirname, 'index.html');

let html = fs.readFileSync(SRC_HTML, 'utf8');

// Guard against a </script> token inside any inlined source terminating the block.
const escape = (s) => s.replace(/<\/script>/gi, '<\\/script>');

// 1. Inline syngen.
{
    const tagRe = /<script\s+src=["']\.\/node_modules\/syngen\/dist\/syngen(?:\.min)?\.js["']><\/script>/;
    if (!tagRe.test(html)) {
        console.error('Could not find syngen <script src> tag in BOH.html');
        process.exit(1);
    }
    const syngen = fs.readFileSync(SYNGEN_JS, 'utf8');
    html = html.replace(
        tagRe,
        `<script>/* syngen (inlined from node_modules/syngen/dist/syngen.min.js) */\n${escape(syngen)}\n</script>`
    );
}

// 2. Inline every <script src="./js/<name>.js"></script>. Order in the HTML
//    is preserved by replacing each tag in place.
const moduleTagRe = /<script\s+src=["']\.\/js\/([\w.-]+)\.js["']><\/script>/g;
let inlinedCount = 0;
html = html.replace(moduleTagRe, (_match, name) => {
    const file = path.join(JS_DIR, `${name}.js`);
    if (!fs.existsSync(file)) {
        console.error(`Referenced module not found: js/${name}.js`);
        process.exit(1);
    }
    const src = fs.readFileSync(file, 'utf8');
    inlinedCount++;
    return `<script>/* js/${name}.js */\n${escape(src)}\n</script>`;
});

// 3. Flip the DEBUG flag off so dev-only hotkeys (e.g. M for the peak-meter
//    report) and any other debug behaviour gated on `if (DEBUG)` are inert in
//    the shipped standalone. The flag is marked in source with the trailing
//    `/* @debug-flag */` comment so the regex can't accidentally match an
//    unrelated `const DEBUG = true`.
{
    const debugRe = /const DEBUG = true;(\s*\/\*\s*@debug-flag\s*\*\/)/;
    if (!debugRe.test(html)) {
        console.error('Could not find DEBUG flag (looking for `const DEBUG = true; /* @debug-flag */`).');
        process.exit(1);
    }
    html = html.replace(debugRe, 'const DEBUG = false;$1');
}

fs.writeFileSync(OUT_HTML, html);
const kb = (html.length / 1024).toFixed(1);
console.log(`Wrote ${path.basename(OUT_HTML)} (${kb} KB; inlined ${inlinedCount} module${inlinedCount === 1 ? '' : 's'} + syngen; DEBUG=false)`);

// 3. Try to send the standalone build to the laptop via Tailscale.
{
    const peer = 'brandonlaptop';
    const result = spawnSync('tailscale', ['file', 'cp', path.basename(OUT_HTML), `${peer}:`], {
        cwd: __dirname,
        encoding: 'utf8',
    });

    if (result.error) {
        if (result.error.code === 'ENOENT') {
            console.warn(`Skipped tailscale send: 'tailscale' command not found on PATH.`);
        } else {
            console.warn(`Skipped tailscale send: ${result.error.message}`);
        }
    } else {
        const out = (result.stdout || '') + (result.stderr || '');
        const offline = /peer is offline/i.test(out);
        if (offline) {
            console.warn(`Tailscale: ${peer} is offline — file not sent.`);
        } else if (result.status !== 0) {
            console.warn(`Tailscale send failed (exit ${result.status}): ${out.trim()}`);
        } else {
            console.log(`Sent ${path.basename(OUT_HTML)} to ${peer} via Tailscale.`);
        }
    }
}
