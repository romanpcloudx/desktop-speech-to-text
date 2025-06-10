// Main process of the Electron application
// Responsible for registering the global shortcut and controlling the overlay window

const { app, globalShortcut, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

if (!process.env.DEEPGRAM_API_KEY) {
  console.warn('Warning: DEEPGRAM_API_KEY is not set. Please create a .env file.');
}

let overlayWindow = null;

function createOverlayWindow() {
  if (overlayWindow) {
    return;
  }

  overlayWindow = new BrowserWindow({
    width: 300,
    height: 120,
    resizable: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      webSecurity: false, // Allow microphone access
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'index.html'));

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    console.log('Overlay window closed, app remains running in background');
  });
}

function registerShortcut() {
  // Try different shortcuts if the first one fails
  const shortcuts = ['Control+Shift+Space', 'Control+Alt+Space', 'Control+Shift+R'];
  
  let registered = false;
  for (const accelerator of shortcuts) {
    try {
      registered = globalShortcut.register(accelerator, () => {
        if (!overlayWindow) {
          // Not recording yet, open overlay which will begin recording automatically
          createOverlayWindow();
        } else {
          // Forward toggle to overlay so it behaves like pressing the stop button
          overlayWindow.webContents.send('shortcut-toggle');
        }
      });
      
      if (registered) {
        console.log(`Global shortcut registered: ${accelerator}`);
        break;
      }
    } catch (error) {
      console.warn(`Failed to register shortcut ${accelerator}:`, error.message);
    }
  }

  if (!registered) {
    console.error('All global shortcut attempts failed. Try closing other apps that might use these shortcuts.');
  }
}

app.whenReady().then(() => {
  console.log('Speech-to-Text app started and ready');
  console.log('Global shortcut will be: Control+Shift+Space (or alternatives)');
  console.log('App will run in background - use Task Manager to close if needed');
  
  // Handle permissions
  const { session } = require('electron');
  
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log(`Permission requested: ${permission}`);
    
    if (permission === 'microphone' || permission === 'media' || permission === 'clipboard-read' || permission === 'clipboard-write') {
      // Always grant microphone/media/clipboard permissions for our app
      console.log(`Granting ${permission} permission`);
      callback(true);
    } else if (permission === 'notifications') {
      // Grant notification permission
      console.log(`Granting ${permission} permission`);
      callback(true);
    } else {
      console.log(`Denying ${permission} permission`);
      callback(false);
    }
  });

  // Also set permission check handler
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    console.log(`Permission check: ${permission} from ${requestingOrigin}`);
    
    if (permission === 'microphone' || permission === 'media' || permission === 'clipboard-read' || permission === 'clipboard-write') {
      return true;
    }
    if (permission === 'notifications') {
      return true;
    }
    return false;
  });

  registerShortcut();

  app.on('activate', () => {
    // macOS dock click handling (not strictly needed for overlay behaviour)
    if (BrowserWindow.getAllWindows().length === 0) {
      // no-op; overlay is only displayed via shortcut
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Prevent app from quitting when all windows are closed (background mode)
app.on('window-all-closed', () => {
  // Keep the app running in background on all platforms
  // Don't quit the app, so the global shortcut keeps working
  console.log('All windows closed, but app remains running for global shortcuts');
});

// IPC listeners
ipcMain.on('close-overlay', () => {
  if (overlayWindow) {
    overlayWindow.close();
  }
});

ipcMain.on('copy-to-clipboard', (_, text) => {
  try {
    clipboard.writeText(text);
  } catch (err) {
    console.error('Failed to copy text to clipboard', err);
  }
});

// Debug log passthrough from renderer to terminal
ipcMain.on('debug-log', (_, payload) => {
  console.log('[Renderer]', payload);
});

// Expose Deepgram key to renderer safely
ipcMain.handle('get-dg-key', () => {
  return process.env.DEEPGRAM_API_KEY || '';
});
