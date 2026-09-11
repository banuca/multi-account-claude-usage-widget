/**
 * platform-paths.js
 *
 * Every filesystem location the app touches outside its own install
 * directory, derived from one place.
 *
 * This exists because two of them were derived independently of Electron's
 * path table and therefore could not be redirected:
 *
 *   - the pre-store legacy config check rebuilt the electron-store path by
 *     hand from os.homedir()/%APPDATA%, so it read (and used to delete) the
 *     REAL user's config even when the process had been pointed at a test
 *     profile with app.setPath('userData', …);
 *   - the Linux desktop/autostart integration wrote under os.homedir(), so a
 *     Linux test run would have written into the developer's own
 *     ~/.config/autostart and ~/.local/share/applications. That is why the
 *     Electron fixtures refused to run on Linux at all.
 *
 * Both now come from the Electron path table (`userData`, `appData`, `home`),
 * which `app.setPath()` redirects, so a fixture that redirects those paths
 * before startup is genuinely isolated on Windows, macOS and Linux alike —
 * and the production paths are unchanged, because that table is exactly where
 * electron-store and the XDG spec point anyway.
 *
 * `describeIsolation()` turns the whole set into data, so a test can assert
 * that nothing at all resolves outside its temporary root rather than trusting
 * that each call site remembered.
 */
'use strict';

const path = require('path');

/**
 * The path electron-store will use for its config file.
 *
 * electron-store defaults `cwd` to app.getPath('userData') and its name to
 * `config`, so this is the same file — read before the Store is constructed
 * so an unusable file can be preserved rather than parsed.
 */
function legacyConfigPath({ userData }) {
  return path.join(userData, 'config.json');
}

/**
 * XDG autostart directory. Electron's `appData` is $XDG_CONFIG_HOME (or
 * ~/.config) on Linux, which is precisely where the spec puts autostart.
 */
function linuxAutostartDir({ appData }) {
  return path.join(appData, 'autostart');
}

/**
 * XDG data home. Electron has no path entry for it, so honour the environment
 * variable first and fall back to the (redirectable) home directory.
 */
function linuxDataHome({ env = {}, home }) {
  return env.XDG_DATA_HOME || path.join(home, '.local', 'share');
}

function linuxDesktopDirs({ env = {}, home }) {
  const dataHome = linuxDataHome({ env, home });
  return {
    dataHome,
    appsDir: path.join(dataHome, 'applications'),
    iconDir: path.join(dataHome, 'icons', 'hicolor', '512x512', 'apps')
  };
}

/**
 * Every location the app may write to outside its own directory, as data.
 *
 * @param {Object} input
 * @param {string} input.platform
 * @param {Object} input.paths  { userData, appData, home, sessionData? }
 * @param {Object} [input.env]
 * @returns {Array<{name: string, path: string, platforms: string[]}>}
 */
function describeIsolation({ platform, paths, env = {} }) {
  const entries = [
    { name: 'userData', path: paths.userData, platforms: ['win32', 'darwin', 'linux'] },
    { name: 'appData', path: paths.appData, platforms: ['win32', 'darwin', 'linux'] },
    { name: 'home', path: paths.home, platforms: ['win32', 'darwin', 'linux'] },
    { name: 'legacyConfig', path: legacyConfigPath(paths), platforms: ['win32', 'darwin', 'linux'] }
  ];
  if (paths.sessionData) {
    entries.push({ name: 'sessionData', path: paths.sessionData, platforms: ['win32', 'darwin', 'linux'] });
  }
  if (platform === 'linux') {
    const desktop = linuxDesktopDirs({ env, home: paths.home });
    entries.push({ name: 'linuxAutostart', path: linuxAutostartDir(paths), platforms: ['linux'] });
    entries.push({ name: 'linuxApps', path: desktop.appsDir, platforms: ['linux'] });
    entries.push({ name: 'linuxIcons', path: desktop.iconDir, platforms: ['linux'] });
  }
  return entries;
}

// Is `candidate` inside `root`? Case-insensitive on Windows and macOS, where
// the filesystem is too.
function isInside(root, candidate) {
  const normalize = (p) => {
    const resolved = path.resolve(p);
    return process.platform === 'linux' ? resolved : resolved.toLowerCase();
  };
  const normRoot = normalize(root);
  const normCandidate = normalize(candidate);
  if (normCandidate === normRoot) return true;
  return normCandidate.startsWith(normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep);
}

/**
 * Which of the described paths escape the given root.
 * @returns {{isolated: boolean, escaped: Array, checked: Array}}
 */
function checkIsolation({ platform, paths, env = {}, root }) {
  const checked = describeIsolation({ platform, paths, env });
  const escaped = checked.filter((entry) => !isInside(root, entry.path));
  return { isolated: escaped.length === 0, escaped, checked };
}

module.exports = {
  legacyConfigPath,
  linuxAutostartDir,
  linuxDataHome,
  linuxDesktopDirs,
  describeIsolation,
  checkIsolation,
  isInside
};
