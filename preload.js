const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onShortcutToggle(callback) {
    ipcRenderer.on('shortcut-toggle', callback);
  },
  closeOverlay() {
    ipcRenderer.send('close-overlay');
  },
  copyToClipboard(text) {
    ipcRenderer.send('copy-to-clipboard', text);
  },
  async getDeepgramKey() {
    return ipcRenderer.invoke('get-dg-key');
  },
  debug(message) {
    ipcRenderer.send('debug-log', message);
  },
});

// Forward console output from the isolated renderer context to the main process
// so it shows up in the terminal where Electron was launched.
['log', 'info', 'warn', 'error'].forEach((level) => {
  const original = console[level];
  console[level] = (...args) => {
    try {
      const payload = args
        .map((arg) => {
          if (typeof arg === 'object') {
            try {
              return JSON.stringify(arg);
            } catch (e) {
              return String(arg);
            }
          }
          return String(arg);
        })
        .join(' ');

      ipcRenderer.send('debug-log', `[console.${level}] ${payload}`);
    } catch (_) {
      /* ignore */
    }

    original(...args);
  };
});
