// scripts/build-obfuscate.js
//
// Bundles the first-party backend source in src/ into a single file and
// obfuscates it, writing the result to ../server.js (the repo root), which
// is the exact path the Windows service (daemon/protogybackend.xml) is
// already pointed at. Nothing about the deployed entry point changes.
//
// All npm dependencies (express, pg, mqtt, ws, etc.) stay external and are
// require()'d normally at runtime from node_modules on the server, exactly
// as today — only YOUR OWN code (server.js, routes.js, nerc.js, auth.js,
// ami.js, db.js, hooks.js, live.js, mqttIngest.js, settings.js) gets
// bundled and obfuscated. This avoids the native-module / dynamic-require
// breakage that bundling third-party packages (pg, mqtt, node-windows)
// tends to cause.
//
// Usage:  npm run build

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SRC_ENTRY = path.join(__dirname, '..', 'src', 'server.js');
const OUT_FILE = path.join(__dirname, '..', 'server.js');
const TMP_BUNDLE = path.join(__dirname, '..', '.build-tmp-bundle.js');

async function main() {
  console.log('[1/3] Bundling src/ with esbuild (node_modules kept external)...');
  await esbuild.build({
    entryPoints: [SRC_ENTRY],
    outfile: TMP_BUNDLE,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    packages: 'external', // keep all npm deps as normal require() calls
    minify: true,
    legalComments: 'none',
  });

  console.log('[2/3] Obfuscating the bundle...');
  const bundled = fs.readFileSync(TMP_BUNDLE, 'utf8');
  const obfuscated = JavaScriptObfuscator.obfuscate(bundled, {
    compact: true,
    controlFlowFlattening: false, // keep off: this is a long-running MQTT/HTTP
    deadCodeInjection: false,     // service — flattening/dead-code hurts perf
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,         // never rename globals in a CJS entry file
    selfDefending: false,         // self-defending breaks under some Node
    disableConsoleOutput: false,  // keep console.log for your own server logs
    target: 'node',
  }).getObfuscatedCode();

  const header =
    '// AUTO-GENERATED — do not hand-edit.\n' +
    '// Built from src/ via `npm run build` (scripts/build-obfuscate.js).\n' +
    '// To change server behavior, edit the files in src/ and rebuild.\n\n';

  fs.writeFileSync(OUT_FILE, header + obfuscated);
  fs.unlinkSync(TMP_BUNDLE);

  console.log(`[3/3] Wrote obfuscated bundle to ${path.relative(process.cwd(), OUT_FILE)}`);
  console.log('Done. Run `npm start` to sanity-check it locally before committing.');
}

main().catch((err) => {
  console.error('Build failed:', err);
  if (fs.existsSync(TMP_BUNDLE)) fs.unlinkSync(TMP_BUNDLE);
  process.exit(1);
});
