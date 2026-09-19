/**
 * preload.cjs — 渲染进程与主进程之间的唯一通道（contextIsolation）
 */
const { contextBridge, ipcRenderer } = require('electron')

const EVENT_MAP = {
  log: 'dsh:log',
  status: 'dsh:status',
  installProgress: 'env:install-progress',
}

contextBridge.exposeInMainWorld('dsh', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  envCheck: () => ipcRenderer.invoke('env:check'),
  envInstall: () => ipcRenderer.invoke('env:install'),
  start: (opts) => ipcRenderer.invoke('dsh:start', opts),
  stop: () => ipcRenderer.invoke('dsh:stop'),
  state: () => ipcRenderer.invoke('dsh:state'),
  attachApp: () => ipcRenderer.invoke('ui:attach'),
  showHome: () => ipcRenderer.invoke('ui:show-home'),
  pickCwd: () => ipcRenderer.invoke('ui:pick-cwd'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  e2eShot: (tag) => ipcRenderer.invoke('e2e:shot', tag),
  on: (name, cb) => {
    const ch = EVENT_MAP[name]
    if (ch) ipcRenderer.on(ch, (_e, data) => cb(data))
  },
})
