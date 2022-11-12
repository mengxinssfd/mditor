process.env['DIST_ELECTRON'] = join(__dirname, '..');
process.env['DIST'] = join(process.env['DIST_ELECTRON'], '../dist');
process.env['PUBLIC'] = app.isPackaged
  ? process.env['DIST']
  : join(process.env['DIST_ELECTRON'], '../public');

import { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage } from 'electron';
import { release } from 'os';
import { join } from 'path';
import { setMenu } from '../menu';
import { readMDFile, saveMDFile } from '../utils/file';
import { isMac, isWin } from '../utils/platform';
import { appConfig, addRecentDocument, setTheme, Theme } from '../utils/app-config';

// Disable GPU Acceleration for Windows 7
if (release().startsWith('6.1')) app.disableHardwareAcceleration();

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName());

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
// Remove electron security warnings
// This warning only shows in development mode
// Read more on https://www.electronjs.org/docs/latest/tutorial/security
// process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

let tray = null;
let win: BrowserWindow | null = null;
// Here, you can also use other preload
const preload = join(__dirname, '../preload/index.js');
const url = process.env['VITE_DEV_SERVER_URL'] as string;
const indexHtml = join(process.env['DIST'], 'index.html');

function createWindow(filePath?: string) {
  win = new BrowserWindow({
    title: 'Main window',
    icon: join(process.env['PUBLIC'] as string, 'icon.png'),
    width: appConfig.window.width,
    height: appConfig.window.height,
    webPreferences: {
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false,
    },
  });

  win.setDocumentEdited(true);

  if (app.isPackaged) {
    win.loadFile(indexHtml);
    // win.webContents.openDevTools();
  } else {
    win.loadURL(url);
    // Open devTool if the app is not packaged
    win.webContents.openDevTools();
  }

  win.on('blur', function () {
    win?.webContents.send('window-blur');
  });

  // Test actively push message to the Electron-Renderer
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString());
    setTheme(win as BrowserWindow, appConfig.theme as Theme);
    // 通过文件关联打开的app
    filePath && readMDFile(win as BrowserWindow, filePath);
  });

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (event) => {
    if (!canClose) {
      win?.webContents.send('win-close-tips');
      event.preventDefault(); //阻止窗口的关闭事件
      return;
    }

    canClose = false;

    if (isMac) return;

    if (win?.isVisible()) {
      win?.hide();
      event.preventDefault();
    } else {
      app.exit(0);
    }
  });
}

let canClose = false;
ipcMain.on('set-can-close', (_, payload: boolean) => (canClose = payload));

ipcMain.on('set-window-size', (_event, { width, height }) => {
  console.log('set-window-size', width, height);
  win?.setSize(width, height);
});

ipcMain.on('save-md-file', (_event, args) => {
  win && saveMDFile(win, args);
});

ipcMain.on('drop-file', (_event, filePath: string) => {
  // 记录最近打开的文件
  addRecentDocument(filePath);
  win?.setRepresentedFilename(filePath);
});

// ipcMain.on('changeSystemTheme', (_event, value: any) => {
//   // 记录最近打开的文件
//   nativeTheme.themeSource = value;
// });

// 渲染线程请求关闭窗口
ipcMain.on('close-window', () => {
  win?.close();
});

// new window example arg: new windows url
ipcMain.handle('open-win', (_event, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (app.isPackaged) {
    childWindow.loadFile(indexHtml, { hash: arg });
  } else {
    childWindow.loadURL(`${url}#${arg}`);
    // childWindow.webContents.openDevTools({ mode: "undocked", activate: true })
  }
});

let filePath: string | undefined;
// window关联app启动
if (app.isPackaged && isWin && process.argv[1]) {
  filePath = process.argv[1];
}

app.whenReady().then(() => {
  createWindow(filePath);
  filePath = undefined;
});
app.on('ready', async () => {
  setMenu(() => win);
  const iconPath = join(app.getAppPath(), (app.isPackaged ? '../' : 'public/') + 'icon.png');
  // 使用nativeImage的话，就算图片是空的也会有个占位
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '退出',
      role: 'quit',
      click: function () {
        app.quit();
      },
    },
  ]);
  tray.setToolTip('编辑器');
  //显示程序页面
  tray.on('click', () => {
    win?.show();
  });
  tray.setContextMenu(contextMenu);
});

// 这里还是有必要的，否则mac直接就关闭了，就算是空的listener都能让窗口维持在任务栏
app.on('window-all-closed', () => {
  // win = null;
  // if (process.platform !== 'darwin') app.quit();
});

// mac专用：点击最近打开的文件或者通过文件关联打开app，读取文件
app.on('open-file', function (_event, filepath: string) {
  // 最近文件打开
  if (win && !win.isDestroyed()) {
    readMDFile(win, filepath);
    return;
  }

  // 文件关联，但窗口关闭时打开
  if (app.isReady()) {
    // 当文件关闭窗口在dock栏的时候，此时没有了窗口
    // 需要重新开启一个窗口
    createWindow(filepath);
  }

  // app未启动，通过文件关联启动，whenReady().then
  filePath = filepath;
});

// windows通过任务栏的图标上的最近的文件打开
app.on('second-instance', (_e, args) => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore();
    win.focus();

    // windows点击最近的文件
    const filePath = args[2];
    if (isWin && filePath) {
      readMDFile(win, filePath);
    }
  }
});

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length) {
    allWindows[0]?.focus();
  } else {
    createWindow();
  }
});
