const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1000,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL(process.env.NATIVE_COMPOSER_URL);
  window.show();
  window.focus();
});
app.on("window-all-closed", () => app.quit());
