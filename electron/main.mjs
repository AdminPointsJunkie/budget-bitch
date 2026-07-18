import { app, BrowserWindow, shell } from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let mainWindow;
let localServer;
let localUrl;

app.setName("Budget Bitch!");

function availablePort() {
  return new Promise((resolve,reject) => {
    const probe=createServer();
    probe.once("error",reject);
    probe.listen(0,"127.0.0.1",() => {
      const {port}=probe.address();
      probe.close(()=>resolve(port));
    });
  });
}

function waitForServer(url,attempts=80) {
  return new Promise((resolve,reject) => {
    const check=async remaining => {
      try {
        const response=await fetch(url);
        if (response.ok) return resolve();
      } catch {}
      if (!remaining) return reject(new Error("The local Budget Bitch! service did not start."));
      setTimeout(()=>check(remaining-1),150);
    };
    check(attempts);
  });
}

async function startLocalServer() {
  const port=await availablePort();
  const appPath=app.getAppPath();
  const vitePath=join(appPath,"node_modules","vite","bin","vite.js");
  const dataDirectory=join(app.getPath("userData"),"data");
  mkdirSync(dataDirectory,{recursive:true});
  if (!existsSync(vitePath)) throw new Error(`Missing application service: ${vitePath}`);
  localServer=spawn(process.execPath,[vitePath,"--configLoader","runner","--host","127.0.0.1","--port",String(port),"--strictPort"],{
    cwd:appPath,
    env:{
      ...process.env,
      ELECTRON_RUN_AS_NODE:"1",
      BUDGET_BITCH_DATA_DIR:dataDirectory
    },
    stdio:"ignore"
  });
  const url=`http://127.0.0.1:${port}`;
  await waitForServer(url);
  return url;
}

async function createWindow() {
  const url=localUrl || await startLocalServer();
  localUrl=url;
  mainWindow=new BrowserWindow({
    width:1500,
    height:960,
    minWidth:1050,
    minHeight:720,
    show:false,
    title:"Budget Bitch!",
    backgroundColor:"#f5f6f8",
    webPreferences:{
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({url:target}) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return {action:"deny"};
  });
  mainWindow.once("ready-to-show",()=>mainWindow?.show());
  await mainWindow.loadURL(url);
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.once("closed",()=>{ mainWindow=null; });
}

app.whenReady().then(createWindow).catch(error => {
  console.error(error);
  app.quit();
});

app.on("activate",() => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else createWindow();
});

app.on("window-all-closed",() => {
  if (process.platform!=="darwin") app.quit();
});

app.on("before-quit",() => {
  if (localServer && !localServer.killed) localServer.kill();
});
