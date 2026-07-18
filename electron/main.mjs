import { app, BrowserWindow, shell } from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let mainWindow;
let localServer;
let localUrl;
let healthTimer;
let isQuitting=false;
let recovering=false;
let lastRecovery=0;
let emptyChecks=0;

app.setName("Budget Bitch!");
app.disableHardwareAcceleration();

function writeLog(message) {
  try {
    const directory=join(app.getPath("userData"),"logs");
    mkdirSync(directory,{recursive:true});
    appendFileSync(join(directory,"desktop.log"),`[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

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
      BUDGET_BITCH_DATA_DIR:dataDirectory,
      BUDGET_BITCH_APP_VERSION:app.getVersion()
    },
    stdio:["ignore","pipe","pipe"]
  });
  localServer.stdout.on("data",chunk=>writeLog(`service: ${String(chunk).trim()}`));
  localServer.stderr.on("data",chunk=>writeLog(`service error: ${String(chunk).trim()}`));
  localServer.once("exit",(code,signal)=>{
    writeLog(`service exited code=${code} signal=${signal||"none"}`);
    localServer=null;
    localUrl=null;
    if (!isQuitting) setTimeout(()=>recoverWindow("local service stopped"),300);
  });
  const url=`http://127.0.0.1:${port}`;
  await waitForServer(url);
  writeLog(`service ready at ${url}`);
  return url;
}

async function recoverWindow(reason) {
  if (isQuitting||recovering||Date.now()-lastRecovery<2500) return;
  recovering=true;
  lastRecovery=Date.now();
  writeLog(`recovery started: ${reason}`);
  try {
    if (!localServer || localServer.exitCode!==null) localUrl=await startLocalServer();
    if (!mainWindow||mainWindow.isDestroyed()) {
      await createWindow();
    } else {
      await mainWindow.loadURL(localUrl);
      mainWindow.show();
      mainWindow.focus();
    }
    emptyChecks=0;
    writeLog("recovery completed");
  } catch(error) {
    writeLog(`recovery failed: ${error.stack||error.message}`);
    setTimeout(()=>{recovering=false;recoverWindow("retry after failed recovery")},2000);
    return;
  }
  recovering=false;
}

function monitorWindow(window) {
  window.webContents.on("did-fail-load",(_event,code,description,url,isMainFrame)=>{
    if (isMainFrame&&code!==-3) {
      writeLog(`page load failed code=${code} description=${description} url=${url}`);
      recoverWindow("page failed to load");
    }
  });
  window.webContents.on("render-process-gone",(_event,details)=>{
    writeLog(`renderer gone reason=${details.reason} code=${details.exitCode}`);
    recoverWindow(`renderer ${details.reason}`);
  });
  window.on("unresponsive",()=>{
    writeLog("window became unresponsive");
    recoverWindow("window unresponsive");
  });
  window.webContents.on("did-finish-load",()=>{
    emptyChecks=0;
    writeLog("page finished loading");
  });
  clearInterval(healthTimer);
  healthTimer=setInterval(async()=>{
    if (!mainWindow||mainWindow.isDestroyed()||mainWindow.webContents.isLoading()) return;
    try {
      const healthy=await mainWindow.webContents.executeJavaScript("Boolean(document.querySelector('#root > *') && document.body.innerText.trim().length > 20)",true);
      emptyChecks=healthy?0:emptyChecks+1;
      if (emptyChecks>=2) recoverWindow("blank renderer detected");
    } catch(error) {
      writeLog(`health check failed: ${error.message}`);
    }
  },5000);
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
  monitorWindow(mainWindow);
  mainWindow.once("ready-to-show",()=>mainWindow?.show());
  await mainWindow.loadURL(url);
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.once("closed",()=>{ mainWindow=null; });
}

app.whenReady().then(createWindow).catch(error => {
  writeLog(`startup failed: ${error.stack||error.message}`);
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
  isQuitting=true;
  clearInterval(healthTimer);
  if (localServer && !localServer.killed) localServer.kill();
});
