import nodePath from 'node:path';

// child_process, fs and os are loaded on first use through a non-literal require. The native Tatakai host runs
// extensions without them: there the bypass reports no browser instead of the whole extension being refused.
type NodeBuiltins = {
  cp: typeof import('node:child_process');
  fs: typeof import('node:fs');
  os: typeof import('node:os');
};
let builtins: NodeBuiltins | null | undefined;
const loadBuiltins = (): NodeBuiltins | null => {
  if (builtins === undefined) {
    try {
      const load = (name: string) => require('node:' + name);
      builtins = { cp: load('child_process'), fs: load('fs'), os: load('os') };
    } catch {
      builtins = null;
    }
  }
  return builtins;
};
// Only called after ensureBrowserRuntime checked that loadBuiltins() succeeded.
const node = (): NodeBuiltins => loadBuiltins() as NodeBuiltins;

type BootstrapResult = {
  hasXvfb: boolean;
  chromePath: string | null;
};

const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
// Downloading and running a browser is opt-in: CF_BYPASS_AUTO_INSTALL=true.
// The installer package is pinned (same version the lockfile resolves) so a
// compromised or broken latest release can't run here unannounced.
const AUTO_INSTALL_ENABLED = String(process.env.CF_BYPASS_AUTO_INSTALL || 'false').toLowerCase() === 'true';
const BROWSERS_INSTALLER = '@puppeteer/browsers@2.6.1';
const localBrowserCacheDir = (): string =>
  process.env.CF_BYPASS_BROWSER_CACHE_DIR || nodePath.join(node().os.homedir(), '.cache', 'tatakai-browser-runtime');

const CHROME_CANDIDATES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium-browser',
  'chromium',
  'chrome',
  'chrome.exe',
  'msedge.exe',
];

const WINDOWS_CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Chromium/Application/chrome.exe',
  'C:/Program Files (x86)/Chromium/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const PORTABLE_BROWSER_EXECUTABLE_NAMES = isWindows
  ? ['chrome.exe', 'msedge.exe']
  : isMac
    ? ['Google Chrome for Testing', 'Google Chrome']
    : ['chrome', 'chromium', 'google-chrome', 'google-chrome-stable'];

const commandExists = (command: string): boolean => {
  const isPathLike = command.includes('/') || command.includes('\\') || nodePath.isAbsolute(command);
  if (isPathLike) {
    try {
      node().fs.accessSync(command, isWindows ? node().fs.constants.F_OK : node().fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const locator = isWindows ? 'where' : 'which';
  const probe = node().cp.spawnSync(locator, [command], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim().length > 0;
};

const resolveCommandPath = (command: string): string | null => {
  const locator = isWindows ? 'where' : 'which';
  const probe = node().cp.spawnSync(locator, [command], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  const lines = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[0] : null;
};

const resolveKnownWindowsChrome = (): string | null => {
  if (!isWindows) return null;
  for (const candidate of WINDOWS_CHROME_PATHS) {
    if (commandExists(candidate)) return candidate;
  }
  return null;
};

const findExecutableRecursively = (root: string, executableNames: string[], maxDepth = 8): string | null => {
  if (!node().fs.existsSync(root)) return null;

  const visited = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (visited.has(current.dir)) continue;
    visited.add(current.dir);

    let entries: string[] = [];
    try {
      entries = node().fs.readdirSync(current.dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = nodePath.join(current.dir, entry);
      let stats;
      try {
        stats = node().fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isFile()) {
        if (!executableNames.some((name) => entry.toLowerCase() === name.toLowerCase())) {
          continue;
        }
        if (commandExists(fullPath)) {
          return fullPath;
        }
      }

      if (stats.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return null;
};

const resolvePortableInstalledChrome = (): string | null => {
  return findExecutableRecursively(localBrowserCacheDir(), PORTABLE_BROWSER_EXECUTABLE_NAMES, 10);
};

const runPortableBrowserInstall = (): boolean => {
  if (!AUTO_INSTALL_ENABLED) return false;
  const npxCommand = isWindows ? 'npx.cmd' : 'npx';
  const install = node().cp.spawnSync(
    npxCommand,
    [
      '-y',
      BROWSERS_INSTALLER,
      'install',
      'chrome@stable',
      '--path',
      localBrowserCacheDir(),
    ],
    { stdio: 'ignore' }
  );
  return install.status === 0;
};

let bootstrapped: BootstrapResult | null = null;

export const ensureBrowserRuntime = (): BootstrapResult => {
  if (bootstrapped) return bootstrapped;
  if (!loadBuiltins()) {
    bootstrapped = { hasXvfb: false, chromePath: null };
    return bootstrapped;
  }

  let hasXvfb = commandExists('Xvfb');
  let chromePath = (process.env.CHROME_PATH || '').trim();
  if (chromePath.length === 0 || !commandExists(chromePath)) {
    chromePath = '';
    for (const candidate of CHROME_CANDIDATES) {
      const resolved = resolveCommandPath(candidate);
      if (resolved) {
        chromePath = resolved;
        break;
      }
    }
    if (!chromePath) chromePath = resolveKnownWindowsChrome() || '';
    if (!chromePath) chromePath = resolvePortableInstalledChrome() || '';
  }

  if (!chromePath && AUTO_INSTALL_ENABLED) {
    if (runPortableBrowserInstall()) {
      chromePath = resolvePortableInstalledChrome() || '';
    }
  }

  if (chromePath) {
    process.env.CHROME_PATH = chromePath;
  }

  bootstrapped = {
    hasXvfb,
    chromePath: chromePath || null,
  };

  return bootstrapped;
};
