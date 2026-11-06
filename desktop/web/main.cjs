const {app, BrowserWindow, dialog, session, shell} = require('electron');
const path = require('node:path');

const SERVER_ORIGIN = 'https://darkdck.duckdns.org';
const START_URL = `${SERVER_ORIGIN}/app`;
const APP_ID = 'org.duckdns.darkdck.desktop';
const SAFE_PREFERENCES = {sandbox: true, contextIsolation: true, nodeIntegration: false};
const WEB_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications', 'speaker-selection']);
const approvedMedia = new Set();
let mediaPrompt = Promise.resolve();
let mainWindow;

function isDxd(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === SERVER_ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

function openWebLink(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      void shell.openExternal(url.href).catch(() => {});
    }
  } catch {
    // Ignore invalid links.
  }
}

function configurePermissions(browserSession) {
  browserSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (!isDxd(origin) || details.embeddingOrigin && !isDxd(details.embeddingOrigin)) return false;
    if (permission === 'media') return approvedMedia.has(details.mediaType);
    return WEB_PERMISSIONS.has(permission);
  });

  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!isDxd(details.requestingUrl) || !isDxd(contents.getURL())) return callback(false);
    if (permission !== 'media') return callback(WEB_PERMISSIONS.has(permission));

    const types = details.mediaTypes ?? [];
    if (!types.length || types.some((type) => type !== 'audio' && type !== 'video')) return callback(false);
    mediaPrompt = mediaPrompt.then(async () => {
      if (contents.isDestroyed() || !isDxd(contents.getURL())) return callback(false);
      const missing = types.filter((type) => !approvedMedia.has(type));
      if (!missing.length) return callback(true);

      const devices = missing.map((type) => type === 'audio' ? 'микрофону' : 'камере').join(' и ');
      let response;
      try {
        ({response} = await dialog.showMessageBox(BrowserWindow.fromWebContents(contents) ?? mainWindow, {
          type: 'question',
          title: 'DxD',
          message: `Разрешить DxD доступ к ${devices}?`,
          buttons: ['Разрешить', 'Отклонить'],
          defaultId: 1,
          cancelId: 1,
        }));
      } catch {
        return callback(false);
      }
      const allowed = response === 0 && !contents.isDestroyed() && isDxd(contents.getURL());
      if (allowed) for (const type of missing) approvedMedia.add(type);
      callback(allowed);
    });
  });
}

function createMainWindow() {
  const window = new BrowserWindow({
    title: 'DxD',
    icon: path.join(__dirname, 'app-icon.png'),
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#171820',
    autoHideMenuBar: true,
    webPreferences: SAFE_PREFERENCES,
  });
  window.removeMenu();
  window.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && isDxd(url) && !window.isDestroyed()) {
      void window.loadFile(path.join(__dirname, 'offline.html')).catch(() => {});
    }
  });
  window.on('closed', () => { mainWindow = undefined; });
  void window.loadURL(START_URL).catch(() => {});
  return window;
}

app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => {
      if (event.isMainFrame && !isDxd(event.url)) event.preventDefault();
    });
    contents.on('will-navigate', (event) => {
      if (isDxd(event.url)) return;
      event.preventDefault();
      openWebLink(event.url);
    });
    contents.setWindowOpenHandler(({url}) => {
      if (isDxd(url)) return {action: 'allow', overrideBrowserWindowOptions: {webPreferences: SAFE_PREFERENCES}};
      openWebLink(url);
      return {action: 'deny'};
    });
  });

  void app.whenReady().then(() => {
    const browserSession = session.defaultSession;
    // Serve the web client. DxD does not use Fluxer's native IPC bridge.
    browserSession.setUserAgent(browserSession.getUserAgent().replace(/\sElectron\/\S+/g, ''));
    configurePermissions(browserSession);
    mainWindow = createMainWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
