const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PAGES = { Chrome: 'chrome://extensions/', Edge: 'edge://extensions/', Chromium: 'chrome://extensions/', Brave: 'brave://extensions/' };
const LINUX_COMMANDS = {
  Chrome: ['google-chrome-stable', 'google-chrome'],
  Chromium: ['chromium', 'chromium-browser'],
  Edge: ['microsoft-edge-stable', 'microsoft-edge'],
  Brave: ['brave-browser', 'brave-browser-stable', 'brave']
};
async function findOnPath(names, directories = (process.env.PATH || '').split(path.delimiter)) {
  for (const directory of directories.filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}
async function launch(executable, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
// Snap and Flatpak installs have no plain binary on PATH.
async function launchLinux(browser, url) {
  const snapNames = { Chromium: 'chromium', Brave: 'brave', Firefox: 'firefox' };
  if (snapNames[browser]) {
    const snap = await findOnPath(['snap'], ['/snap/bin', '/usr/bin']);
    if (snap && await fs.access(`/snap/${snapNames[browser]}/current`).then(() => true, () => false)) return launch(snap, ['run', snapNames[browser], url]);
  }
  // Only distributions that publish these applications on Flathub.
  const flatpakIds = { Chromium: ['org.chromium.Chromium'], Brave: ['com.brave.Browser'], Firefox: ['org.mozilla.firefox'] }[browser] || [];
  const flatpak = await findOnPath(['flatpak'], ['/usr/bin', '/usr/local/bin']);
  if (flatpak) {
    for (const application of flatpakIds) {
      if (await fs.access(path.join(os.homedir(), '.var', 'app', application)).then(() => true, () => false)) return launch(flatpak, ['run', application, url]);
    }
  }
  return null;
}
async function openExtensions(browser) {
  const url = PAGES[browser];
  if (!url || (process.platform === 'win32' && !['Chrome', 'Edge'].includes(browser))) throw new Error(process.platform === 'win32' ? 'Choose Chrome or Edge.' : 'Choose Chrome, Chromium, Edge or Brave.');
  if (process.platform !== 'win32') {
    const executable = await findOnPath(LINUX_COMMANDS[browser]);
    if (executable) return launch(executable, [url]);
    const packaged = await launchLinux(browser, url);
    if (packaged) return packaged;
    throw new Error(`${browser} was not found. Open ${url} in your browser manually.`);
  }
  const relative = { Chrome: 'Google/Chrome/Application/chrome.exe', Edge: 'Microsoft/Edge/Application/msedge.exe' }[browser];
  for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const executable = path.join(root, relative);
    try { await fs.access(executable); } catch { continue; }
    return launch(executable, [url]);
  }
  throw new Error(`${browser} was not found. Open ${url} in your browser manually.`);
}
module.exports = { openExtensions };
