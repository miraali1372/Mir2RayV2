import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XrayManager } from './xray-manager.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const debugEnabled = process.env.MIR2RAY_DESKTOP_DEBUG === '1';
const elevationArgument = '--mir2ray-elevated';
const startupLog = path.join(
  process.env.LOCALAPPDATA || app.getPath('temp'),
  'Mir2rayV2',
  'startup.log',
);

function sanitizeStartupError(error) {
  return String(error instanceof Error ? error.stack || error.message : error || 'Unknown startup error')
    .replace(/(?:vless|vmess|trojan|ss):\/\/\S+/gi, '[config]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .slice(0, 4000);
}

function appendStartupLog(message, error) {
  try {
    fs.mkdirSync(path.dirname(startupLog), { recursive: true });
    const detail = error ? `: ${sanitizeStartupError(error)}` : '';
    fs.appendFileSync(startupLog, `${new Date().toISOString()} ${message}${detail}\n`);
  } catch {
    // Startup diagnostics must never keep the application from opening.
  }
}

function reportStartupError(message, error) {
  appendStartupLog(message, error);
  const detail = error instanceof Error ? error.message : String(error || message);
  const show = () => dialog.showErrorBox(
    'Mir2rayV2',
    `${detail}\n\nStartup log: ${startupLog}`,
  );
  if (app.isReady()) show();
  else void app.whenReady().then(show).catch(() => {});
}

function isProcessElevated() {
  if (process.platform !== 'win32') return true;
  const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  const result = spawnSync(whoami, ['/groups', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  return /S-1-16-(?:12288|16384)/i.test(`${result.stdout || ''}\n${result.stderr || ''}`);
}

function pendingElevationFile() {
  return manager ? path.join(manager.dataRoot, 'pending-elevation.bin') : '';
}

async function storePendingElevation(options) {
  const destination = pendingElevationFile();
  if (!destination || !safeStorage.isEncryptionAvailable()) return false;
  const encrypted = safeStorage.encryptString(JSON.stringify(options || {}));
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.writeFile(temporary, encrypted);
  await fs.promises.rm(destination, { force: true });
  await fs.promises.rename(temporary, destination);
  return true;
}

async function takePendingElevation() {
  const source = pendingElevationFile();
  if (!source) return null;
  try {
    const encrypted = await fs.promises.readFile(source);
    await fs.promises.rm(source, { force: true });
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch (error) {
    await fs.promises.rm(source, { force: true }).catch(() => {});
    appendStartupLog('Pending elevated connection could not be restored', error);
    return null;
  }
}

async function removePendingElevation() {
  const source = pendingElevationFile();
  if (source) await fs.promises.rm(source, { force: true }).catch(() => {});
}

function launchPortableElevated() {
  const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const escapedTarget = target.replace(/'/g, "''");
  const script = `Start-Process -FilePath '${escapedTarget}' -ArgumentList '${elevationArgument}' -Verb RunAs`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  return new Promise(resolve => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorOutput = '';
    child.stderr?.on('data', chunk => { errorOutput = `${errorOutput}${chunk}`.slice(-2000); });
    child.once('error', error => resolve({ ok: false, message: error.message }));
    child.once('exit', code => resolve({
      ok: code === 0,
      message: code === 0 ? '' : sanitizeStartupError(errorOutput || `Elevation exited with code ${code}`),
    }));
  });
}

async function elevateAndContinueConnection(options) {
  let pendingStored = false;
  try {
    pendingStored = await storePendingElevation(options);
  } catch (error) {
    appendStartupLog('Could not store pending elevated connection', error);
  }

  app.releaseSingleInstanceLock();
  const launched = await launchPortableElevated();
  if (!launched.ok) {
    app.requestSingleInstanceLock();
    await removePendingElevation();
    appendStartupLog('Administrator elevation was not granted', launched.message);
    return {
      status: 'error',
      message: 'Administrator permission was not granted. VPN connection requires elevated access on Windows.',
    };
  }

  appendStartupLog('Elevated application handoff started');
  setTimeout(() => {
    quitting = true;
    app.quit();
  }, 750);
  return {
    status: 'error',
    message: pendingStored
      ? 'Mir2rayV2 is reopening with administrator access and will continue the connection.'
      : 'Mir2rayV2 is reopening with administrator access. Press Connect again after it opens.',
  };
}

appendStartupLog('Desktop process started');
process.on('uncaughtException', error => reportStartupError('Uncaught startup exception', error));
process.on('unhandledRejection', error => appendStartupLog('Unhandled process rejection', error));
if (debugEnabled) {
  app.setPath(
    'userData',
    process.env.MIR2RAY_DEBUG_USER_DATA
      || path.join(app.getPath('temp'), 'Mir2rayV2-Debug')
  );
  app.commandLine.appendSwitch('remote-debugging-port', process.env.MIR2RAY_DEBUG_PORT || '9333');
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow = null;
let manager = null;
let quitting = false;
let rendererRestartAttempted = false;

function createWindow() {
  const icon = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'icon.png')
    : path.resolve('output', 'imagegen', 'mir2rayv2-icon-transparent.png');
  mainWindow = new BrowserWindow({
    width: 480,
    height: 860,
    minWidth: 420,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    icon,
    webPreferences: {
      preload: path.join(directory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: debugEnabled,
    },
  });
  let revealed = false;
  const reveal = () => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return;
    revealed = true;
    mainWindow.show();
  };
  const revealTimer = setTimeout(() => {
    appendStartupLog('Window reveal fallback used');
    reveal();
  }, 5000);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url));
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => {
    clearTimeout(revealTimer);
    appendStartupLog('Window ready to show');
    reveal();
  });
  mainWindow.webContents.once('did-finish-load', () => {
    appendStartupLog('Renderer loaded');
    reveal();
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    if (code === -3) return;
    reveal();
    reportStartupError('Renderer failed to load', new Error(`${description} (${code})`));
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'launch-failed' && !rendererRestartAttempted) {
      rendererRestartAttempted = true;
      appendStartupLog('Renderer launch failed; retrying once', new Error(`exit code ${details.exitCode}`));
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
      }, 1000);
      return;
    }
    reportStartupError(
      'Renderer process stopped',
      new Error(`${details.reason}; exit code ${details.exitCode}`),
    );
  });
  mainWindow.on('closed', () => {
    clearTimeout(revealTimer);
    mainWindow = null;
  });
  const page = app.isPackaged ? path.join(app.getAppPath(), 'dist', 'index.html') : path.resolve('dist', 'index.html');
  void mainWindow.loadFile(page).catch(error => {
    reveal();
    reportStartupError('Application page could not be opened', error);
  });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  appendStartupLog('Electron ready');
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  manager = new XrayManager();
  try {
    await manager.initialize();
    appendStartupLog('Windows runtime initialized');
  } catch (error) {
    reportStartupError('Windows runtime initialization failed', error);
  }
  ipcMain.handle('mir2ray:invoke', (_event, method, options) => {
    if (app.isPackaged && method === 'startVpn' && !isProcessElevated()) {
      return elevateAndContinueConnection(options);
    }
    return manager.invoke(method, options);
  });
  createWindow();
  if (process.argv.includes(elevationArgument)) {
    void takePendingElevation().then(async options => {
      if (!options) return;
      const result = await manager.startVpn(options);
      if (result.status === 'error') {
        appendStartupLog('Elevated connection handoff failed', result.message);
      } else {
        appendStartupLog('Elevated connection handoff completed');
      }
    });
  }
}).catch(error => reportStartupError('Electron failed before creating the window', error));

app.on('window-all-closed', () => app.quit());

app.on('before-quit', event => {
  if (quitting || !manager) return;
  event.preventDefault();
  quitting = true;
  void manager.stopVpn().finally(() => app.quit());
});
