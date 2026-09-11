// Inspects what is actually inside a built package.
//
//   node test/verify-package-contents.cjs --app <unpacked-app-dir> [--out <dir>]
//                                          [--source <project-dir>]
//
// The old build.files pattern was `**/*` minus *.ts and *.md, so a release
// carried the whole test suite, test-results/, snapshot-pre-edit/, the CI
// workflows, every screenshot in assets/ and the bundled font files. A
// checklist tick is not evidence that an allowlist works, so this reads the
// real asar (and the unpacked resources beside it) and asserts both halves:
// everything the app needs at runtime is present, and none of the things that
// must never ship are.
//
// With --source it also proves CORRESPONDENCE: every application file inside
// the archive is compared byte for byte against the file of the same path in
// the source tree. That is a different question from "is the right set of files
// in there", and it is the one that catches the failure that matters most in a
// delivery - an archive built from source that has since changed, so the
// package launched in the evidence is not the package the source describes.
// Reviewing a stale archive proves nothing about the code under review.
//
// It also writes the full file listing next to the results, so the claim can be
// checked rather than taken on trust.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');

const args = process.argv.slice(2);
const optionOf = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const appDir = optionOf('--app');
// The source tree the archive is supposed to have been built from. Optional so
// the contents checks still run where the source is not present (inspecting a
// downloaded artifact, say), and the correspondence check then says it was not
// performed rather than passing silently.
const sourceDir = optionOf('--source');
const outDir = optionOf('--out') || path.join(os.tmpdir(), `usage-package-contents-${process.pid}`);
if (!appDir) {
  console.error('usage: node test/verify-package-contents.cjs --app <unpacked-app-dir> [--out <dir>]');
  process.exit(64);
}
fs.mkdirSync(outDir, { recursive: true });

const resourcesDir = fs.existsSync(path.join(appDir, 'resources'))
  ? path.join(appDir, 'resources')
  : path.join(appDir, 'Contents', 'Resources'); // macOS .app layout
const asarPath = path.join(resourcesDir, 'app.asar');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || null });
  console.log(`[contents] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!fs.existsSync(asarPath)) {
  record('the package contains an app.asar', false, `not found at ${asarPath}`);
  console.log('\n[contents] 0/1 checks passed');
  process.exit(1);
}

// listPackage gives every entry, directories included, as an
// archive-absolute path ("/main.js"). The per-file sizes come from the
// asar's own header rather than from statFile: statFile's path handling
// differs between nested trees, and an under-counted file list would have
// made the credential scan below look at almost nothing.
const listing = asar.listPackage(asarPath)
  .map((entry) => entry.replace(/\\/g, '/').replace(/^\//, ''));

// Walk the header tree: a node with a numeric `size` is a file.
const fileSizes = new Map();
(function walk(node, prefix) {
  for (const [name, child] of Object.entries((node && node.files) || {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (child && child.files) walk(child, full);
    else if (child && typeof child.size === 'number') fileSizes.set(full, child.size);
  }
}(asar.getRawHeader(asarPath).header, ''));
const files = [...fileSizes.keys()];
fs.writeFileSync(path.join(outDir, 'app-asar-listing.txt'), listing.join('\n') + '\n');

const has = (target) => listing.includes(target);
const matching = (pattern) => listing.filter((entry) => pattern.test(entry));

record('the package contains an app.asar', true,
  `${listing.length} entries, ${files.length} files, ${fs.statSync(asarPath).size} bytes on disk`);

// The header walk and the listing must agree about how many files there
// are, or one of them is not seeing the whole archive - and every check
// below depends on seeing the whole archive.
record('the archive listing and its header agree on the file set',
  files.length > 0 && files.every((entry) => listing.includes(entry)),
  `${files.length} files from the header, ${listing.length} listed entries,`
  + ` ${files.filter((e) => !listing.includes(e)).length} header files missing from the listing`);

// ── Everything the app needs at runtime ───────────────────────────────────
const required = [
  'main.js',
  'preload.js',
  'package.json',
  'LICENSE',
  'src/renderer/index.html',
  'src/renderer/app.js',
  'src/renderer/styles.css',
  // Applies the saved theme before the first paint; a package without it
  // starts every window in the dark theme whatever the user chose.
  'src/renderer/theme-boot.js',
  'src/usage-status.js',
  'src/manual-entry.js',
  'src/providers.js',
  'src/fetch-via-window.js',
  'src/account-logic.js',
  'src/config-recovery.js',
  'src/credential-store.js',
  'src/platform-paths.js',
  'src/read-errors.js',
  'node_modules/chart.js/dist/chart.umd.js'
];
const missing = required.filter((entry) => !has(entry));
record('every runtime source file and the chart library are present',
  missing.length === 0,
  missing.length ? `MISSING: ${missing.join(', ')}` : `all ${required.length} present`);

// The icons main.js actually loads, per platform.
const requiredIcons = ['assets/icon.ico', 'assets/icon.icns', 'assets/icons/512x512.png',
  'assets/tray-icon.png', 'assets/tray-icon-mac.png', 'assets/tray-icon-linux.png'];
const missingIcons = requiredIcons.filter((entry) => !has(entry));
record('every icon the app loads at runtime is present',
  missingIcons.length === 0,
  missingIcons.length ? `MISSING: ${missingIcons.join(', ')}` : `all ${requiredIcons.length} present`);

// Production dependencies must be there; dev dependencies must not.
record('the production dependencies are packaged',
  has('node_modules/electron-store/index.js') && matching(/^node_modules\/chart\.js\//).length > 0,
  `electron-store=${has('node_modules/electron-store/index.js')} chart.js entries=${matching(/^node_modules\/chart\.js\//).length}`);

const devDependencyDirs = ['electron-builder', 'app-builder-lib', 'cross-env', 'electron', 'dmg-builder', '7zip-bin'];
const leakedDev = devDependencyDirs.filter((name) => matching(new RegExp(`^node_modules/${name}/`)).length > 0);
record('no development dependency was packaged',
  leakedDev.length === 0,
  leakedDev.length ? `LEAKED: ${leakedDev.join(', ')}` : `checked ${devDependencyDirs.join(', ')}`);

// ── Everything that must never ship ───────────────────────────────────────
const forbidden = [
  { name: 'the test suites', pattern: /^test\// },
  { name: 'test results and reports', pattern: /^test-results\// },
  { name: 'the pre-edit snapshot', pattern: /^snapshot-pre-edit\// },
  { name: 'the design/verification docs', pattern: /^docs\// },
  { name: 'the CI workflows', pattern: /^\.github\// },
  { name: 'a previous dist output', pattern: /^dist\// },
  { name: 'markdown files', pattern: /\.md$/ },
  { name: 'bundled font files', pattern: /^assets\/fonts\// },
  { name: 'screenshots and marketing images', pattern: /^assets\/(screenshot|claude-usage-screenshot|logo)/ },
  { name: 'any configuration or profile data', pattern: /(^|\/)config\.json$/ },
  { name: 'source maps', pattern: /\.map$/ },
  { name: 'TypeScript sources', pattern: /\.ts$/ }
];
for (const rule of forbidden) {
  const found = matching(rule.pattern);
  record(`${rule.name} are not in the package`,
    found.length === 0,
    found.length ? `FOUND ${found.length}: ${found.slice(0, 6).join(', ')}` : 'none');
}

// A credential or cookie must never be baked into a package.
const suspicious = listing.filter((entry) => /sessionKey|Cookies$|\.pem$|\.key$/.test(entry));
record('no credential, cookie store or key material is in the package',
  suspicious.length === 0,
  suspicious.length ? `FOUND: ${suspicious.join(', ')}` : 'none');

// ── The licence has to be readable, not just present ──────────────────────
try {
  const licence = asar.extractFile(asarPath, 'LICENSE').toString('utf8');
  record('the licence text ships and is readable',
    /MIT License/i.test(licence) && licence.length > 500,
    `${licence.length} bytes, first line: ${JSON.stringify(licence.split('\n')[0])}`);
} catch (err) {
  record('the licence text ships and is readable', false, err.message);
}

// Electron's own licences sit beside the executable, not in the asar.
const electronLicences = fs.existsSync(appDir)
  ? fs.readdirSync(appDir).filter((f) => /^LICENSE/i.test(f))
  : [];
record('Electron\'s own licence files ship alongside the application',
  electronLicences.length > 0,
  electronLicences.length ? electronLicences.join(', ') : `nothing matching LICENSE* in ${appDir}`);

// ── The packaged package.json must describe the app, not the toolchain ────
try {
  const packaged = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
  const own = require('../package.json');
  record('the packaged package.json carries the app\'s own version and entry point',
    packaged.version === own.version && packaged.main === 'main.js' && packaged.name === own.name,
    `name=${packaged.name} version=${packaged.version} main=${packaged.main}`);
} catch (err) {
  record('the packaged package.json carries the app\'s own version and entry point', false, err.message);
}

// ── Correspondence: the archive against the source it came from ───────────
if (sourceDir) {
  const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
  // node_modules is a build input, not project source: electron-builder
  // rewrites parts of it (and prunes it), so comparing it would be comparing
  // the packager's work with npm's. Everything else in the archive is the
  // application, and every byte of it must match.
  //
  // package.json is the one application file electron-builder rewrites: it
  // strips devDependencies and the whole build block. Its CONTENT is checked
  // above (name, version, entry point) rather than by hash, because a hash
  // comparison there would fail on every correct build.
  const REWRITTEN_BY_PACKAGER = new Set(['package.json']);
  const appFiles = files.filter((entry) => !entry.startsWith('node_modules/')
    && !REWRITTEN_BY_PACKAGER.has(entry));
  const mismatched = [];
  const absent = [];
  const compared = [];
  for (const entry of appFiles) {
    const onDisk = path.join(sourceDir, entry.split('/').join(path.sep));
    if (!fs.existsSync(onDisk)) {
      // package.json is rewritten by electron-builder (it strips devDependencies
      // and build config), so it is checked by content above rather than by hash.
      absent.push(entry);
      continue;
    }
    let packaged;
    try {
      packaged = asar.extractFile(asarPath, entry.split('/').join(path.sep));
    } catch (err) {
      mismatched.push({ entry, reason: `could not be read from the archive: ${err.message}` });
      continue;
    }
    const live = fs.readFileSync(onDisk);
    const same = sha(packaged) === sha(live);
    compared.push({ entry, packaged: sha(packaged), source: sha(live), same });
    if (!same) mismatched.push({ entry, reason: 'content differs from the source tree' });
  }

  record('every packaged application file exists in the source tree',
    absent.length === 0,
    absent.length
      ? `not in the source: ${absent.slice(0, 10).join(', ')}`
      : `${compared.length} compared; ${[...REWRITTEN_BY_PACKAGER].join(', ')} rewritten by the packager and checked by content instead`);

  record('every packaged application file is byte-identical to the source it was built from',
    mismatched.length === 0,
    mismatched.length
      ? `STALE ARCHIVE: ${mismatched.slice(0, 10).map((m) => `${m.entry} (${m.reason})`).join('; ')}`
      : `${compared.length} file(s) match by SHA-256`);

  fs.writeFileSync(path.join(outDir, 'archive-source-correspondence.json'), JSON.stringify({
    sourceDir,
    asarPath,
    comparedCount: compared.length,
    mismatched,
    missingFromSource: absent,
    rewrittenByPackager: [...REWRITTEN_BY_PACKAGER],
    files: compared
  }, null, 2) + '\n');
} else {
  console.log('[contents] NOTE --source was not given, so archive/source correspondence was NOT checked');
}

const totalBytes = [...fileSizes.values()].reduce((sum, size) => sum + size, 0);
console.log(`[contents] asar holds ${files.length} files, ${totalBytes} bytes of content`);

fs.writeFileSync(path.join(outDir, 'package-contents.json'), JSON.stringify({
  appDir,
  asarPath,
  asarBytes: fs.statSync(asarPath).size,
  entryCount: listing.length,
  fileCount: files.length,
  sourceDir: sourceDir || null,
  correspondenceChecked: !!sourceDir,
  contentBytes: totalBytes,
  electronLicences,
  results
}, null, 2) + '\n');

const failed = results.filter((r) => !r.ok);
console.log(`\n[contents] ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('[contents] failing checks:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
process.exit(failed.length ? 1 : 0);
