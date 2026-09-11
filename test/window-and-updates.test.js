// Unit checks for two things the user notices only when they go wrong: the
// window coming back somewhere visible, and the update notice being truthful.
//
// Both are offline and platform-independent. The display arrangements below
// are fixtures, not this machine's monitors — the real-runtime counterpart is
// the geometry precondition in test/electron-usage-status-smoke.js, which
// measures the window that actually exists.
const assert = require('assert');

const { isReachable, displayFor, fitBoundsToDisplays } = require('../src/window-bounds');
const { isNewerVersion, parseReleaseResponse, releasesUrlFor } = require('../src/version-compare');

// A laptop screen plus a monitor to its right, and the laptop alone.
const LAPTOP = { id: 1, primary: true, scaleFactor: 1.5, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const RIGHT = { id: 2, primary: false, scaleFactor: 1, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };
// A monitor to the LEFT gives negative coordinates, which is the case naive
// clamping to (0, 0) gets wrong.
const LEFT = { id: 3, primary: false, scaleFactor: 1, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };

const LIMITS = { minWidth: 480, minHeight: 150 };

function testReachability() {
  // On the laptop: fine.
  assert.strictEqual(isReachable({ x: 100, y: 100, width: 640, height: 480 }, [LAPTOP]), true);
  // Where the second monitor used to be: not fine.
  assert.strictEqual(isReachable({ x: 2400, y: 300, width: 640, height: 480 }, [LAPTOP]), false);
  // Still fine while that monitor is attached.
  assert.strictEqual(isReachable({ x: 2400, y: 300, width: 640, height: 480 }, [LAPTOP, RIGHT]), true);
  // Mostly off the bottom, but the top strip is still grabbable.
  assert.strictEqual(isReachable({ x: 100, y: 1000, width: 640, height: 480 }, [LAPTOP]), true);
  // Entirely below the work area.
  assert.strictEqual(isReachable({ x: 100, y: 1500, width: 640, height: 480 }, [LAPTOP]), false);
  // No displays at all is not "reachable".
  assert.strictEqual(isReachable({ x: 0, y: 0, width: 640, height: 480 }, []), false);
}

function testDisplaySelection() {
  assert.strictEqual(displayFor({ x: 2000, y: 100, width: 640, height: 480 }, [LAPTOP, RIGHT]).id, 2);
  assert.strictEqual(displayFor({ x: 100, y: 100, width: 640, height: 480 }, [LAPTOP, RIGHT]).id, 1);
  // Overlapping nothing falls back to the primary display, not to index 0.
  assert.strictEqual(displayFor({ x: 9000, y: 9000, width: 640, height: 480 }, [RIGHT, LAPTOP]).id, 1);
}

function testFitting() {
  // THE REGRESSION: bounds saved on a monitor that is no longer attached used
  // to be handed straight to BrowserWindow, putting the window off-screen with
  // no tray to restore it from.
  const stranded = fitBoundsToDisplays({ x: 2400, y: 300, width: 640, height: 480 }, [LAPTOP], LIMITS);
  assert.strictEqual(stranded.changed, true);
  assert.strictEqual(stranded.reason, 'moved-onto-an-attached-display');
  assert.strictEqual(isReachable(stranded.bounds, [LAPTOP]), true);
  assert.strictEqual(stranded.bounds.width, 640, 'the size the user chose is kept');
  assert.strictEqual(stranded.bounds.height, 480);
  assert.strictEqual(stranded.displayId, 1);

  // Nothing to do when the arrangement is unchanged.
  const fine = fitBoundsToDisplays({ x: 100, y: 100, width: 640, height: 480 }, [LAPTOP, RIGHT], LIMITS);
  assert.strictEqual(fine.changed, false);
  assert.strictEqual(fine.reason, 'unchanged');
  assert.deepStrictEqual(fine.bounds, { x: 100, y: 100, width: 640, height: 480 });

  // A window on the second monitor stays there while it exists.
  const onSecond = fitBoundsToDisplays({ x: 2400, y: 300, width: 640, height: 480 }, [LAPTOP, RIGHT], LIMITS);
  assert.strictEqual(onSecond.changed, false);
  assert.strictEqual(onSecond.displayId, 2);

  // Negative coordinates are legitimate on a left-hand monitor.
  const onLeft = fitBoundsToDisplays({ x: -1200, y: 200, width: 640, height: 480 }, [LEFT, LAPTOP], LIMITS);
  assert.strictEqual(onLeft.changed, false);
  assert.strictEqual(onLeft.bounds.x, -1200);
  // ...and are corrected when that monitor goes away.
  const leftGone = fitBoundsToDisplays({ x: -1200, y: 200, width: 640, height: 480 }, [LAPTOP], LIMITS);
  assert.strictEqual(leftGone.bounds.x >= 0, true);
  assert.strictEqual(isReachable(leftGone.bounds, [LAPTOP]), true);

  // A window bigger than the remaining display is shrunk to fit, not left
  // hanging off the edges.
  const tooBig = fitBoundsToDisplays({ x: 0, y: 0, width: 3000, height: 2000 }, [LAPTOP], LIMITS);
  assert.strictEqual(tooBig.bounds.width, 1920);
  assert.strictEqual(tooBig.bounds.height, 1040);

  // Partly off the bottom-right: pulled fully inside the work area.
  const overhang = fitBoundsToDisplays({ x: 1800, y: 1000, width: 640, height: 480 }, [LAPTOP], LIMITS);
  assert.strictEqual(overhang.bounds.x + overhang.bounds.width <= 1920, true);
  assert.strictEqual(overhang.bounds.y + overhang.bounds.height <= 1040, true);

  // The app's minimum size wins over a smaller saved size.
  const tiny = fitBoundsToDisplays({ x: 10, y: 10, width: 200, height: 80 }, [LAPTOP], LIMITS);
  assert.strictEqual(tiny.bounds.width, 480);
  assert.strictEqual(tiny.bounds.height, 150);

  // A display smaller than the app minimum: fitting on screen wins.
  const tinyDisplay = { id: 9, primary: true, bounds: { x: 0, y: 0, width: 400, height: 300 }, workArea: { x: 0, y: 0, width: 400, height: 300 } };
  const onTiny = fitBoundsToDisplays({ x: 0, y: 0, width: 640, height: 480 }, [tinyDisplay], LIMITS);
  assert.strictEqual(onTiny.bounds.width, 400);
  assert.strictEqual(onTiny.bounds.height, 300);

  // No saved bounds, and no display information: never invent a position.
  assert.strictEqual(fitBoundsToDisplays(null, [LAPTOP], LIMITS).bounds, null);
  const blind = fitBoundsToDisplays({ x: 5, y: 5, width: 640, height: 480 }, [], LIMITS);
  assert.strictEqual(blind.reason, 'no-display-information');
  assert.deepStrictEqual(blind.bounds, { x: 5, y: 5, width: 640, height: 480 });
}

function testDpiChange() {
  // A scaling change reports a smaller work area in DIPs; the window has to
  // come back inside it.
  const rescaled = { ...LAPTOP, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 0, width: 1280, height: 680 } };
  const fitted = fitBoundsToDisplays({ x: 1500, y: 600, width: 640, height: 480 }, [rescaled], LIMITS);
  assert.strictEqual(isReachable(fitted.bounds, [rescaled]), true);
  assert.strictEqual(fitted.bounds.x + fitted.bounds.width <= 1280, true);
  assert.strictEqual(fitted.bounds.y + fitted.bounds.height <= 680, true);
}

function testVersionComparison() {
  assert.strictEqual(isNewerVersion('3.1.0', '3.0.0'), true);
  assert.strictEqual(isNewerVersion('3.0.1', '3.0.0'), true);
  assert.strictEqual(isNewerVersion('4.0.0', '3.9.9'), true);
  assert.strictEqual(isNewerVersion('3.0.0', '3.0.0'), false);
  assert.strictEqual(isNewerVersion('2.9.9', '3.0.0'), false);
  // Pre-releases are never announced.
  assert.strictEqual(isNewerVersion('3.1.0-rc.1', '3.0.0'), false);
  assert.strictEqual(isNewerVersion('4.0.0-beta', '3.0.0'), false);
  // ...but a stable release does supersede a local pre-release.
  assert.strictEqual(isNewerVersion('3.0.0', '3.0.0-rc.1'), true);
  // Short and malformed tags do not throw.
  assert.strictEqual(isNewerVersion('3.1', '3.0.0'), true);
  assert.strictEqual(isNewerVersion('', '3.0.0'), false);
  assert.strictEqual(isNewerVersion('nonsense', '3.0.0'), false);
}

function testReleaseResponseFailsClosed() {
  const current = '3.0.0';

  // The happy path.
  assert.deepStrictEqual(
    parseReleaseResponse(JSON.stringify({ tag_name: 'v3.1.0' }), current),
    { hasUpdate: true, version: '3.1.0', reason: 'newer-stable-release' });
  // A tag without the v prefix works too.
  assert.strictEqual(parseReleaseResponse(JSON.stringify({ tag_name: '3.2.0' }), current).version, '3.2.0');

  // Everything else must fail closed. None of these may reach the user as a
  // release notification.
  const closed = [
    ['', 'empty-response'],
    ['   ', 'empty-response'],
    [undefined, 'empty-response'],
    ['<html><body>502 Bad Gateway</body></html>', 'unparseable-response'],
    ['{"tag_name": "v3.1.0"', 'unparseable-response'],
    ['[]', 'unexpected-response-shape'],
    ['null', 'unexpected-response-shape'],
    ['"just a string"', 'unexpected-response-shape'],
    [JSON.stringify({}), 'no-tag'],
    [JSON.stringify({ tag_name: '' }), 'no-tag'],
    [JSON.stringify({ tag_name: 'v3.0.0' }), 'not-newer'],
    [JSON.stringify({ tag_name: 'v2.0.0' }), 'not-newer'],
    [JSON.stringify({ tag_name: 'v3.1.0', draft: true }), 'draft-or-prerelease'],
    [JSON.stringify({ tag_name: 'v3.1.0', prerelease: true }), 'draft-or-prerelease'],
    [JSON.stringify({ tag_name: 'nightly-build' }), 'unrecognised-tag:nightly-build']
  ];
  for (const [body, reason] of closed) {
    const decision = parseReleaseResponse(body, current);
    assert.strictEqual(decision.hasUpdate, false, `body ${JSON.stringify(body)} must not offer an update`);
    assert.strictEqual(decision.version, null);
    assert.strictEqual(decision.reason, reason, `body ${JSON.stringify(body)}`);
  }

  // GitHub's rate-limit / not-found shape is reported as such, not as a release.
  const limited = parseReleaseResponse(JSON.stringify({ message: 'API rate limit exceeded' }), current);
  assert.strictEqual(limited.hasUpdate, false);
  assert.match(limited.reason, /^api-message:API rate limit/);

  // A local pre-release still gets told about the stable release.
  assert.strictEqual(parseReleaseResponse(JSON.stringify({ tag_name: 'v3.0.0' }), '3.0.0-rc.2').hasUpdate, true);
}

function testReleasesUrl() {
  assert.strictEqual(releasesUrlFor('banuca', 'ai-usage-monitor'),
    'https://github.com/banuca/ai-usage-monitor/releases/latest');
  // It points at the project's releases page, and nothing else.
  const url = new URL(releasesUrlFor('banuca', 'ai-usage-monitor'));
  assert.strictEqual(url.protocol, 'https:');
  assert.strictEqual(url.hostname, 'github.com');
  assert.match(url.pathname, /\/releases\/latest$/);
}

const tests = [
  testReachability,
  testDisplaySelection,
  testFitting,
  testDpiChange,
  testVersionComparison,
  testReleaseResponseFailsClosed,
  testReleasesUrl
];

let failed = 0;
for (const test of tests) {
  try {
    test();
    console.log(`PASS  ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${test.name}\n      ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} window/update test groups passed`);
if (failed) process.exit(1);
