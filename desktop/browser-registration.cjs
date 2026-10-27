const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const HOST = 'com.awesome.downloader';
const isWindows = () => process.platform === 'win32';

// Windows: per-user registry key. Linux: a manifest file in the browser's own
// NativeMessagingHosts directory (browsers do not read a registry there).
const WINDOWS_ROOTS = { Chrome: 'Google\\Chrome', Edge: 'Microsoft\\Edge', Firefox: 'Mozilla' };
function linuxManifestDirectories(browser, home = os.homedir()) {
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const directories = {
    Chrome: [path.join(config, 'google-chrome', 'NativeMessagingHosts')],
    Chromium: [path.join(config, 'chromium', 'NativeMessagingHosts'), path.join(home, 'snap', 'chromium', 'common', 'chromium', 'NativeMessagingHosts')],
    Edge: [path.join(config, 'microsoft-edge', 'NativeMessagingHosts')],
    Brave: [path.join(config, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts')],
    Firefox: [path.join(home, '.mozilla', 'native-messaging-hosts')]
  };
  return directories[browser] || [];
}
// Profile roots that hold each Chromium-family browser's "Preferences" files.
function linuxProfileRoots(home = os.homedir()) {
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    ['Chrome', path.join(config, 'google-chrome')],
    ['Chromium', path.join(config, 'chromium')],
    ['Chromium', path.join(home, 'snap', 'chromium', 'common', 'chromium')],
    ['Edge', path.join(config, 'microsoft-edge')],
    ['Brave', path.join(config, 'BraveSoftware', 'Brave-Browser')]
  ];
}
function hostExecutable(integrationRoot) {
  return path.join(integrationRoot, 'integration', isWindows() ? 'native-host.exe' : 'native-host.sh');
}

async function registerBrowser({ browser, extensionId }, { dataDirectory, integrationRoot }) {
  const allowed = isWindows() ? ['Chrome', 'Edge', 'Firefox'] : ['Chrome', 'Chromium', 'Edge', 'Brave', 'Firefox'];
  if (!allowed.includes(browser)) throw new Error(`Choose ${allowed.join(', ')}.`);
  if (typeof extensionId !== 'string' || !(browser === 'Firefox' ? /^[A-Za-z0-9@._{}-]{1,128}$/ : /^[a-p]{32}$/).test(extensionId)) throw new Error('Copy the extension ID from your browser’s extensions page.');
  const folder = path.join(dataDirectory, 'NativeMessaging');
  const manifestPath = path.join(folder, `${browser}.json`);
  const manifest = { name: HOST, description: 'Awesome Downloader browser bridge', path: hostExecutable(integrationRoot), type: 'stdio' };
  if (browser === 'Firefox') manifest.allowed_extensions = [extensionId];
  else manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
  const content = JSON.stringify(manifest, null, 2);
  await fs.access(manifest.path);
  await fs.mkdir(folder, { recursive: true });
  let previous;
  try { previous = await fs.readFile(manifestPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  if (previous && previous !== content) await fs.writeFile(`${manifestPath}.${stamp}.bak`, previous);
  if (previous !== content) await fs.writeFile(manifestPath, content, 'utf8');
  if (isWindows()) await registerWindows(browser, manifestPath, folder, stamp);
  else await registerLinux(browser, content);
  let extensionPath = path.join(integrationRoot, 'extension');
  if (browser === 'Firefox') {
    extensionPath = path.join(folder, 'firefox-extension');
    await fs.cp(path.join(integrationRoot, 'extension'), extensionPath, { recursive: true });
    await fs.copyFile(path.join(extensionPath, 'manifest.firefox.json'), path.join(extensionPath, 'manifest.json'));
  }
  return { ok: true, manifestPath, extensionPath };
}
async function registerWindows(browser, manifestPath, folder, stamp) {
  const key = `HKCU\\Software\\${WINDOWS_ROOTS[browser]}\\NativeMessagingHosts\\${HOST}`;
  let registry = null;
  try { registry = (await exec('reg.exe', ['QUERY', key, '/ve'], { windowsHide: true })).stdout; }
  catch (error) { if (error.code !== 1) throw error; }
  const previousPath = registry?.match(/REG_SZ\s+(.+)\r?\n?/)?.[1]?.trim();
  if (registry && previousPath !== manifestPath) await fs.writeFile(path.join(folder, `${browser}.${stamp}.registry-backup.txt`), registry);
  if (previousPath !== manifestPath) await exec('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
}
// Only this product's own `com.awesome.downloader.json` file is ever written;
// an existing different one is backed up beside it first.
async function registerLinux(browser, content) {
  for (const directory of linuxManifestDirectories(browser)) {
    const target = path.join(directory, `${HOST}.json`);
    // Snap/secondary locations are only used when that browser is installed.
    const browserRoot = path.dirname(directory);
    if (directory !== linuxManifestDirectories(browser)[0]) { try { await fs.access(browserRoot); } catch { continue; } }
    await fs.mkdir(directory, { recursive: true });
    let existing;
    try { existing = await fs.readFile(target, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing === content) continue;
    if (existing) await fs.writeFile(`${target}.${new Date().toISOString().replaceAll(/[:.]/g, '-')}.bak`, existing);
    await fs.writeFile(target, content, 'utf8');
  }
}
// Read only extension registrations, never browser history, cookies, or page data.
async function connectInstalledBrowsers({ dataDirectory, integrationRoot, localAppData = process.env.LOCALAPPDATA }) {
  const results = [];
  const roots = isWindows()
    ? [['Chrome', path.join(localAppData || '', 'Google/Chrome/User Data')], ['Edge', path.join(localAppData || '', 'Microsoft/Edge/User Data')]]
    : linuxProfileRoots();
  const connected = new Map();
  for (const [browser, root] of roots) {
    let profiles;
    try { profiles = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    const ids = new Set();
    for (const profile of profiles.filter(p => p.isDirectory() && /^(Default|Profile \d+)$/.test(p.name))) {
      for (const file of ['Preferences', 'Secure Preferences']) {
        try {
          const settings = JSON.parse(await fs.readFile(path.join(root, profile.name, file), 'utf8')).extensions?.settings || {};
          for (const [id, entry] of Object.entries(settings)) {
            if (!/^[a-p]{32}$/.test(id) || !entry.path || !path.isAbsolute(entry.path)) continue;
            const installed = await fs.realpath(entry.path).catch(() => null);
            const expected = await fs.realpath(path.join(integrationRoot, 'extension'));
            let ownExtension = installed?.toLowerCase() === expected.toLowerCase();
            if (installed && !ownExtension) {
              const manifest = JSON.parse(await fs.readFile(path.join(installed, 'manifest.json'), 'utf8'));
              const background = await fs.readFile(path.join(installed, 'background.js'), 'utf8');
              ownExtension = manifest.name === 'Awesome Downloader Integration' && manifest.background?.service_worker === 'background.js' && background.includes("const HOST = 'com.awesome.downloader'");
            }
            if (ownExtension) ids.add(id);
          }
        } catch { /* A running browser can temporarily replace a preference file. */ }
      }
    }
    if (ids.size) {
      // Snap and native Chromium share a name; merge their extension IDs.
      for (const id of ids) { if (!connected.has(browser)) connected.set(browser, new Set()); connected.get(browser).add(id); }
    }
  }
  for (const [browser, ids] of connected) {
    const result = await registerBrowser({ browser, extensionId: [...ids][0] }, { dataDirectory, integrationRoot });
    // Multiple profiles may assign different IDs to this same unpacked extension.
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    manifest.allowed_origins = [...ids].map(id => `chrome-extension://${id}/`);
    const content = JSON.stringify(manifest, null, 2);
    await fs.writeFile(result.manifestPath, content);
    if (!isWindows()) await registerLinux(browser, content);
    results.push({ browser, connected: true });
  }
  return results;
}
async function prepareNativeHost(integrationRoot, executable) {
  const folder = path.join(integrationRoot, 'integration');
  if (isWindows()) {
    const target = path.join(folder, 'native-host.exe');
    try { await fs.access(target); }
    catch {
      const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      await exec(compiler, ['/nologo', '/target:exe', `/out:${target}`, path.join(folder, 'NativeHostLauncher.cs')], { windowsHide: true });
    }
  } else {
    // A POSIX launcher replaces the compiled C# one: Chrome runs it directly and
    // talks to it over stdin/stdout. Single-quote escaping keeps odd paths safe.
    const quote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
    const script = path.join(folder, 'native-host.sh');
    const body = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(executable)} ${quote(path.join(folder, 'native-host.cjs'))} "$@"\n`;
    let current; try { current = await fs.readFile(script, 'utf8'); } catch { /* first run */ }
    if (current !== body) await fs.writeFile(script, body, { mode: 0o755 });
    await fs.chmod(script, 0o755);
  }
  await fs.writeFile(path.join(folder, 'runtime-path.txt'), executable, 'utf8');
}
module.exports = { registerBrowser, connectInstalledBrowsers, prepareNativeHost, linuxManifestDirectories };
