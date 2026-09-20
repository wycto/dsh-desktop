/**
 * main.mjs — DSH Desktop 主进程
 *
 * 职责：
 * 1. 环境检测：没有 Node/npm 时引导一键安装（见 nodeenv.mjs）
 * 2. 启动 `npx @deepseek-ai/dsh web`：只负责传 --host/--port，其余交给 dsh
 * 3. 更新弹窗：自己查 registry 发现新版本时弹窗询问，绝不让用户面对命令行
 * 4. 壳页面：dsh 起来后把带 token 的页面内嵌到窗口里（解析 `dsh web: <url>` 输出）
 */
import { app, BrowserWindow, WebContentsView, dialog, ipcMain, shell, Menu } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  detectNodeEnv, installNode, latestLtsVersion, spawnEnv,
} from './nodeenv.mjs'
import { startProxy, stopProxy, proxyState } from './lanproxy.mjs'

const IS_WIN = process.platform === 'win32'
const E2E = process.env.DSH_E2E === '1'
const E2E_LOG = '/tmp/dsh-e2e.log'
const HEADER_H = 52
const PKG_SPEC = '@deepseek-ai/dsh'

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const defaultSettings = () => ({
  host: '127.0.0.1',
  port: 8080,
  cwd: os.homedir(),
  checkUpdate: true,
  autoApplyUpdate: false,
  lastUsedVersion: '',
  confirmQuit: true,
  remoteEnabled: false,
  remotePort: 8688,
  remoteListen: '0.0.0.0',
  language: 'zh',
})
let settings = defaultSettings()
// 缩放仅作用于本次启动：每次打开都从 100% 开始，不写入 settings.json
let zoomFactor = 1

function loadSettings() {
  try {
    settings = { ...defaultSettings(), ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }
  } catch {}
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
  } catch {}
}

function e2eMark(mark, extra = {}) {
  if (!E2E) return
  try { fs.appendFileSync(E2E_LOG, JSON.stringify({ t: Date.now(), mark, ...extra }) + '\n') } catch {}
}

// ---------------------------------------------------------------------------
// 界面语言（菜单 / 对话框）与页面缩放
// ---------------------------------------------------------------------------

const MESSAGES = {
  zh: {
    menuApp: (name) => ({
      label: name,
      submenu: [
        { label: `关于 ${name}`, role: 'about' },
        { type: 'separator' },
        { label: '隐藏', role: 'hide' },
        { label: '隐藏其他窗口', role: 'hideOthers' },
        { label: '全部显示', role: 'unhide' },
        { type: 'separator' },
        { label: `退出 ${name}`, role: 'quit' },
      ],
    }),
    menuFile: '文件',
    menuClose: '关闭窗口',
    menuQuit: '退出',
    menuEdit: '编辑',
    menuUndo: '撤销',
    menuRedo: '重做',
    menuCut: '剪切',
    menuCopy: '复制',
    menuPaste: '粘贴',
    menuPasteMatch: '粘贴并匹配样式',
    menuDelete: '删除',
    menuSelectAll: '全选',
    menuSpeech: '语音',
    menuStartSpeaking: '开始朗读',
    menuStopSpeaking: '停止朗读',
    menuView: '视图',
    menuWindow: '窗口',
    menuMinimize: '最小化',
    menuZoomWindow: '缩放',
    menuFullscreen: '切换全屏',
    menuDevTools: '开发者工具',
    menuReload: '重新加载',
    menuZoomIn: '放大',
    menuZoomOut: '缩小',
    menuZoomReset: '实际大小',
    menuZoomResetSuffix: '',
    menuAbout: '关于',
    menuLang: '语言 / Language',
    menuLangZh: '中文',
    menuLangEn: 'English',
    langSwitchedTitle: 'Language',
    langSwitched: '界面语言已切换为 English。',
    updateDialog: {
      title: '发现 dsh 新版本',
      message: (latest, prev) => `发现 dsh 新版本 ${latest}（上次使用 ${prev}）。`,
      detail: '更新需要下载新组件，可能需要几分钟；也可以先用当前版本启动。',
      buttons: ['立即更新并启动', '使用当前版本启动'],
    },
    quitDialog: {
      title: '退出 DSH Desktop',
      message: 'dsh 服务正在运行，退出会停止服务。',
      detail: '未完成的任务会中断，但历史会话不会丢失。',
      buttons: ['退出并停止服务', '取消'],
      checkbox: '下次不再询问',
    },
    pickCwdTitle: '选择工作目录',
  },
  en: {
    menuApp: (name) => ({ label: name, submenu: [{ role: 'appMenu' }] }),
    menuFile: 'File',
    menuClose: 'Close Window',
    menuQuit: 'Quit',
    menuEdit: 'Edit',
    menuUndo: 'Undo',
    menuRedo: 'Redo',
    menuCut: 'Cut',
    menuCopy: 'Copy',
    menuPaste: 'Paste',
    menuPasteMatch: 'Paste and Match Style',
    menuDelete: 'Delete',
    menuSelectAll: 'Select All',
    menuSpeech: 'Speech',
    menuStartSpeaking: 'Start Speaking',
    menuStopSpeaking: 'Stop Speaking',
    menuView: 'View',
    menuWindow: 'Window',
    menuMinimize: 'Minimize',
    menuZoomWindow: 'Zoom',
    menuFullscreen: 'Toggle Full Screen',
    menuDevTools: 'Developer Tools',
    menuReload: 'Reload',
    menuZoomIn: 'Zoom In',
    menuZoomOut: 'Zoom Out',
    menuZoomReset: 'Actual Size',
    menuZoomResetSuffix: '',
    menuAbout: 'About',
    menuLang: 'Language / 语言',
    menuLangZh: '中文',
    menuLangEn: 'English',
    langSwitchedTitle: '界面语言',
    langSwitched: '界面语言已切换为中文。',
    updateDialog: {
      title: 'New dsh version available',
      message: (latest, prev) => `A new dsh version ${latest} is available (previously used ${prev}).`,
      detail: 'Updating needs to download new components and may take a few minutes; you can also start with the current version.',
      buttons: ['Update now and start', 'Start with current version'],
    },
    quitDialog: {
      title: 'Quit DSH Desktop',
      message: 'The dsh service is still running. Quitting will stop it.',
      detail: 'Unfinished tasks will be interrupted, but history sessions are kept.',
      buttons: ['Quit and stop service', 'Cancel'],
      checkbox: "Don't ask again",
    },
    pickCwdTitle: 'Select Working Directory',
  },
}

/** 当前界面语言（未设置时跟随系统，非中文一律英文）。 */
function lang() {
  const l = settings.language
  if (l === 'zh' || l === 'en') return l
  return (app.getLocale() || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
const T = () => MESSAGES[lang()]

const ZOOM_MIN = 0.5
const ZOOM_MAX = 3

/**
 * 整体缩放（与浏览器一致：顶栏和页面一起缩放，且顶栏永远不会遮住页面）。
 *
 * 原理：壳页面按 zoomFactor 缩放；内嵌 dsh 页面固定 zoomFactor=1/s，
 * 同时把它的可视区域放大 s 倍——内嵌页内容的呈现尺寸 = 区域 × s × (1/s)，
 * 即始终与壳顶栏严丝合缝，视觉上只有壳在缩放，实现整体缩放不遮挡。
 * 仅本次会话生效，每次启动从 100% 开始。
 */
function setZoom(factor) {
  zoomFactor = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(factor * 100) / 100))
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoomFactor)
  if (appView) {
    appView.webContents.setZoomFactor(1 / zoomFactor)
    appView.setBounds(contentRect())
  }
}

/** Ctrl/⌘ +/-/0 缩放（只由 before-input-event 处理，避免与菜单加速器重复触发）。 */
function registerZoomShortcuts() {
  const zoom = (dir) => setZoom(dir === 0 ? 1 : zoomFactor + 0.1 * dir)
  const onKey = (_e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return
    const key = (input.key || '').toLowerCase()
    if (key === '=' || key === '+') zoom(1)
    else if (key === '-') zoom(-1)
    else if (key === '0') zoom(0)
  }
  win.webContents.on('before-input-event', onKey)
  appView?.webContents.on('before-input-event', onKey)
}

// ---------------------------------------------------------------------------
// dsh 子进程状态
// ---------------------------------------------------------------------------

/** @type {import('node:child_process').ChildProcess|null} */
let dshProc = null
const intentionalStopPids = new Set()
let runState = {
  phase: 'idle', // idle | starting | running | stopping
  url: '', version: '', host: '', port: 0,
}
let envInfo = null // 最近一次检测结果

function setStatus(phase, extra = {}) {
  runState = { ...runState, phase, ...extra }
  send('dsh:status', { phase, url: runState.url, version: runState.version })
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const stripAnsi = (s) => s
  .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
  .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')

// ---------------------------------------------------------------------------
// dsh 版本检查（更新弹窗由我们自己驱动，避免用户面对 npx 的 y/N 提示）
// ---------------------------------------------------------------------------

async function fetchLatestVersion(registry) {
  const base = (registry || 'https://registry.npmjs.org').replace(/\/+$/, '')
  const url = `${base}/${encodeURIComponent(PKG_SPEC)}/latest`
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!resp.ok) throw new Error(`registry HTTP ${resp.status}`)
  const j = await resp.json()
  if (!j.version) throw new Error('registry 返回无版本号')
  return j.version
}

async function resolveVersion(opts) {
  const prev = settings.lastUsedVersion || ''
  let latest = null
  let online = true
  try {
    latest = await fetchLatestVersion(envInfo?.registry)
  } catch (err) {
    online = false
    send('dsh:log', { stream: 'shell', text: `[壳] 无法查询 dsh 最新版本（${err.message}），将使用本地缓存版本启动` })
  }
  if (!opts.checkUpdate) {
    if (prev) return { version: prev }
    if (latest) return { version: latest }
    return { version: null }
  }
  if (!online) {
    if (prev) return { version: prev, offline: true }
    return { version: null, offline: true }
  }
  if (!prev) return { version: latest } // 第一次使用：静默用最新
  if (latest === prev) return { version: prev }
  // 有新版本
  if (opts.autoApplyUpdate) {
    send('dsh:log', { stream: 'shell', text: `[壳] 发现 dsh 新版本 ${latest}，已开启自动更新，直接使用新版` })
    e2eMark('update-auto', { latest, prev })
    return { version: latest }
  }
  let useLatest = true
  if (E2E && process.env.DSH_E2E_UPDATE_CHOICE) {
    useLatest = process.env.DSH_E2E_UPDATE_CHOICE === 'update'
  } else {
    const d = T().updateDialog
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: d.title,
      message: d.message(latest, prev),
      detail: d.detail,
      buttons: d.buttons,
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    useLatest = response === 0
  }
  e2eMark('update-choice', { useLatest, latest, prev })
  return useLatest ? { version: latest } : { version: prev }
}

// ---------------------------------------------------------------------------
// dsh 启动 / 停止
// ---------------------------------------------------------------------------

function killDsh() {
  return new Promise((resolve) => {
    const p = dshProc
    if (!p) { resolve(); return }
    dshProc = null
    intentionalStopPids.add(p.pid)
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve() } }
    if (IS_WIN) {
      const killer = spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('exit', done)
      killer.on('error', done)
      setTimeout(done, 5000)
    } else {
      try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
      const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL') } catch {}; done() }, 5000)
      p.once('exit', () => { clearTimeout(t); done() })
    }
  })
}

function startDshProcess({ host, port, cwd, version, offline }) {
  const spec = version ? `${PKG_SPEC}@${version}` : PKG_SPEC
  const args = [envInfo.npxCliJs, '-y', offline ? '--offline' : '--prefer-offline', spec,
    'web', '--no-open', '--host', host, '--port', String(port)]
  const proc = spawn(envInfo.nodePath, args, {
    cwd,
    env: spawnEnv(envInfo.nodeDir),
    detached: !IS_WIN, // posix 建立新进程组，便于整组杀掉
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  dshProc = proc
  const verLabel = version || 'latest'
  e2eMark('spawning', { pid: proc.pid, version: verLabel, host, port, cwd })
  send('dsh:log', { stream: 'shell', text: `[壳] 启动命令: node ${args.map((a) => (a === args[0] ? a : a)).join(' ')}` })
  send('dsh:log', { stream: 'shell', text: `[壳] dsh 版本: ${verLabel}${offline ? '（离线缓存模式）' : ''}，工作目录: ${cwd}` })
  setStatus('starting', { url: '', version: verLabel, host, port })

  let readySeen = false
  let lineBuf = { out: '', err: '' }
  const pump = (streamName) => (chunk) => {
    lineBuf[streamName] += chunk.toString('utf8')
    const lines = lineBuf[streamName].split(/\r?\n/)
    lineBuf[streamName] = lines.pop() || ''
    for (const raw of lines) {
      const line = stripAnsi(raw)
      if (!line.trim()) continue
      send('dsh:log', { stream: streamName, text: line })
      const m = line.match(/^dsh web:\s*(https?:\/\/\S+)/)
      if (m && !readySeen) {
        readySeen = true
        const url = m[1]
        const vm = line.match(/@deepseek-ai\/dsh@(\d[^\s]*)/)
        const usedVersion = version || vm?.[1] || ''
        if (usedVersion) { settings.lastUsedVersion = usedVersion; saveSettings() }
        runState.url = url
        if (usedVersion) runState.version = usedVersion
        setStatus('running', { url })
        e2eMark('ready', { url, version: runState.version })
        attachAppView()
        applyRemote()
      }
      if (/EADDRINUSE|address already in use/i.test(line)) {
        send('dsh:log', { stream: 'shell', text: `[壳] 端口 ${port} 已被占用，请在主页面换一个端口后重新启动` })
      }
      if (/Ok to proceed\?/i.test(line)) {
        try { proc.stdin.write('y\n') } catch {}
      }
    }
  }
  proc.stdout.on('data', pump('out'))
  proc.stderr.on('data', pump('err'))

  proc.on('exit', (code, signal) => {
    if (dshProc === proc) dshProc = null
    send('dsh:log', { stream: 'shell', text: `[壳] dsh 进程退出（code=${code ?? '-'} signal=${signal ?? '-'}）` })
    const wasReady = readySeen
    const wasIntentional = intentionalStopPids.delete(proc.pid)
    e2eMark('dsh-exit', { code, signal, wasReady })
    detachAppView()
    stopProxy()
    send('dsh:remote-state', proxyState())
    if (!wasReady && !wasIntentional) {
      setStatus('idle', {
        url: '', version: '', host: '', port: 0,
        error: 'dsh 启动失败（常见原因：端口被占用、无法访问 npm 源、本地缓存损坏）。请查看下方运行日志，必要时换端口或点“重启服务”重试。',
      })
    } else {
      setStatus('idle', { url: '', version: '', host: '', port: 0 })
    }
  })
  proc.on('error', (err) => {
    send('dsh:log', { stream: 'shell', text: `[壳] 启动失败: ${err.message}` })
  })
}

async function handleStart(opts = {}) {
  const host = String(opts.host || settings.host || '127.0.0.1').trim() || '127.0.0.1'
  const port = Number.parseInt(String(opts.port ?? settings.port ?? 8080), 10)
  const checkUpdate = opts.checkUpdate ?? settings.checkUpdate
  const autoApplyUpdate = opts.autoApplyUpdate ?? settings.autoApplyUpdate
  if (!/^[a-zA-Z0-9.\-_]+$/.test(host)) return { ok: false, reason: 'IP 格式不正确' }
  if (host === '0.0.0.0') return { ok: false, reason: 'dsh 出于安全限制不允许绑定 0.0.0.0，请使用 127.0.0.1 或 localhost' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: '端口必须是 1-65535 的数字' }

  envInfo = await detectNodeEnv()
  e2eMark('env-checked', { ok: envInfo.ok, node: envInfo.nodeVersion })
  if (!envInfo.ok) return { ok: false, needInstall: true, reason: '未检测到 Node.js 环境' }

  let cwd = opts.cwd || settings.cwd || os.homedir()
  try { if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir() } catch { cwd = os.homedir() }

  if (runState.phase === 'starting' || runState.phase === 'running') await killDsh()

  setStatus('starting')
  const picked = await resolveVersion({ checkUpdate, autoApplyUpdate })
  e2eMark('version-picked', picked)
  startDshProcess({ host, port, cwd, version: picked.version, offline: picked.offline })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 内嵌 dsh 页面
// ---------------------------------------------------------------------------

let appView = null

function contentRect() {
  const [w, h] = win.getContentSize()
  // 内嵌页可视区域放大 s 倍，配合其 zoomFactor=1/s，内容呈现尺寸与壳一致
  return { x: 0, y: HEADER_H, width: Math.round(w * zoomFactor), height: Math.max(1, Math.round((h - HEADER_H) * zoomFactor)) }
}

function attachAppView() {
  if (!win || !runState.url) return
  detachAppView(true)
  appView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      scrollBounce: true,
    },
  })
  appView.setBackgroundColor('#f6f7fb')
  appView.webContents.setZoomFactor(1 / Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomFactor)))
  appView.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target)
    return { action: 'deny' }
  })
  appView.webContents.on('render-process-gone', (_e, details) => {
    send('dsh:log', { stream: 'shell', text: `[壳] 内嵌页面异常退出: ${details.reason}` })
  })
  win.contentView.addChildView(appView)
  appView.setBounds(contentRect())
  appView.webContents.loadURL(runState.url).catch((err) => {
    send('dsh:log', { stream: 'shell', text: `[壳] 页面加载失败: ${err.message}` })
  })
  send('dsh:status', { phase: 'running', url: runState.url, version: runState.version, embedded: true })
}

function detachAppView(quiet = false) {
  if (appView && win && !win.isDestroyed()) {
    try { win.contentView.removeChildView(appView) } catch {}
    try { appView.webContents.close() } catch {}
    appView = null
    if (!quiet) send('dsh:status', { phase: runState.phase, url: runState.url, version: runState.version, embedded: false })
  }
}

// ---------------------------------------------------------------------------
// 手机/局域网访问代理
// ---------------------------------------------------------------------------

function lanAddresses() {
  // 物理网卡（en*/eth*/wlan*…）排前面，utun/docker 等虚拟接口排后面，
  // 让默认展示的地址大概率是手机真正可达的那个
  const score = (name) => /^(en[0-9]|eth[0-9]*|wlan[0-9]*|eno[0-9]*|ens[0-9a-z]*)/i.test(name) ? 2
    : /^(utun|docker|bridge|vmnet|veth|awdl|llw|lo)/i.test(name) ? 0
    : 1
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) out.push({ name, address: it.address })
    }
  }
  out.sort((a, b) => score(b.name) - score(a.name))
  return out.map((it) => it.address)
}

/** 按设置与 dsh 运行状态开启/关闭/切换局域网代理，状态变化广播给渲染层。 */
async function applyRemote() {
  const listenIp = settings.remoteListen || '0.0.0.0'
  const want = !!settings.remoteEnabled && runState.phase === 'running' && !!runState.port
  const cur = proxyState()
  if (!want) {
    if (cur.running) {
      stopProxy()
      send('dsh:log', { stream: 'shell', text: '[壳] 已关闭手机/局域网访问代理' })
    }
    send('dsh:remote-state', proxyState())
    return proxyState()
  }
  if (cur.running && cur.listenIp === listenIp && cur.listenPort === settings.remotePort && cur.targetPort === runState.port) return cur
  stopProxy()
  const res = await startProxy({
    listenIp,
    listenPort: settings.remotePort,
    targetPort: runState.port,
    onLog: (text) => send('dsh:log', { stream: 'shell', text }),
  })
  if (res.ok) {
    send('dsh:log', { stream: 'shell', text: `[壳] 手机访问已开启：${listenIp}:${settings.remotePort} → 127.0.0.1:${runState.port}` })
  }
  send('dsh:remote-state', proxyState())
  return res
}

// ---------------------------------------------------------------------------
// 应用菜单（中英文，含页面缩放与语言切换）
// ---------------------------------------------------------------------------

function buildMenu() {
  const t = T()
  const isMac = process.platform === 'darwin'

  const template = [
    ...(isMac ? [t.menuApp(app.name)] : []),
    {
      label: t.menuFile,
      submenu: [
        ...(isMac ? [] : [
          { label: t.menuAbout, click: showAbout },
          { type: 'separator' },
        ]),
        isMac
          ? { label: t.menuClose, role: 'close' }
          : { label: t.menuQuit, role: 'quit' },
      ],
    },
    {
      label: t.menuEdit,
      submenu: [
        { label: t.menuUndo, role: 'undo' },
        { label: t.menuRedo, role: 'redo' },
        { type: 'separator' },
        { label: t.menuCut, role: 'cut' },
        { label: t.menuCopy, role: 'copy' },
        { label: t.menuPaste, role: 'paste' },
        ...(isMac ? [
          { label: t.menuPasteMatch, role: 'pasteAndMatchStyle' },
          { label: t.menuDelete, role: 'delete' },
          { label: t.menuSelectAll, role: 'selectAll' },
          { type: 'separator' },
          {
            label: t.menuSpeech,
            submenu: [
              { label: t.menuStartSpeaking, role: 'startSpeaking' },
              { label: t.menuStopSpeaking, role: 'stopSpeaking' },
            ],
          },
        ] : [
          { label: t.menuDelete, role: 'delete' },
          { type: 'separator' },
          { label: t.menuSelectAll, role: 'selectAll' },
        ]),
      ],
    },
    {
      label: t.menuView,
      submenu: [
        { label: t.menuReload, role: 'reload' },
        { label: t.menuDevTools, role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: `${t.menuZoomIn}（Ctrl +）`,
          click: () => setZoom(zoomFactor + 0.1),
        },
        {
          label: `${t.menuZoomOut}（Ctrl -）`,
          click: () => setZoom(zoomFactor - 0.1),
        },
        {
          label: `${t.menuZoomReset}（Ctrl 0）${t.menuZoomResetSuffix}`,
          click: () => setZoom(1),
        },
        { type: 'separator' },
        { label: t.menuFullscreen, role: 'togglefullscreen' },
      ],
    },
    {
      label: t.menuLang,
      submenu: [
        {
          label: t.menuLangZh,
          type: 'radio',
          checked: lang() === 'zh',
          click: () => switchLang('zh'),
        },
        {
          label: t.menuLangEn,
          type: 'radio',
          checked: lang() === 'en',
          click: () => switchLang('en'),
        },
      ],
    },
    {
      label: t.menuWindow,
      submenu: [
        { label: t.menuMinimize, role: 'minimize' },
        ...(isMac ? [{ label: t.menuZoomWindow, role: 'zoom' }] : []),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function rebuildMenu() {
  try { buildMenu() } catch {}
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'DSH Desktop',
    message: `DSH Desktop v${app.getVersion()}`,
    detail: 'DSH Web 桌面启动器：双击即用，自动管理 Node 环境与 dsh 更新\nhttps://github.com/wycto/dsh-desktop',
    buttons: ['OK'],
    noLink: true,
  })
}

async function switchLang(l) {
  settings.language = l
  saveSettings()
  rebuildMenu()
  send('dsh:lang', { lang: l })
  // 内嵌 dsh 页面是它自己的界面，同步切换它的显示语言
  try {
    if (appView) await appView.webContents.executeJavaScript(
      `localStorage.setItem('locale', ${JSON.stringify(l === 'zh' ? 'zh-CN' : 'en-US')}); location.reload()`, true)
  } catch {}
  const msg = MESSAGES[l]
  dialog.showMessageBox(win, {
    type: 'info',
    title: msg.langSwitchedTitle,
    message: msg.langSwitched,
    buttons: ['OK'],
    noLink: true,
  })
}

let win = null
let quitting = false

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: `DSH Web 桌面版 v${app.getVersion()}`,
    backgroundColor: '#f6f7fb',
    show: false,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  registerZoomShortcuts()
  win.loadFile(path.join(import.meta.dirname, 'shell', 'index.html'))
  win.once('ready-to-show', () => win.show())
  win.on('resize', () => { if (appView) appView.setBounds(contentRect()) })
  win.on('closed', () => { win = null })
  win.on('close', async (e) => {
    if (quitting || !win) return
    const running = runState.phase === 'running' || runState.phase === 'starting'
    if (!running || !settings.confirmQuit) return
    e.preventDefault()
    const d = T().quitDialog
    const { response, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'question',
      title: d.title,
      message: d.message,
      detail: d.detail,
      buttons: d.buttons,
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: d.checkbox,
      checkboxChecked: false,
      noLink: true,
    })
    if (response !== 0) return
    if (checkboxChecked) { settings.confirmQuit = false; saveSettings() }
    quitting = true
    await killDsh()
    app.quit()
  })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  e2e: E2E ? { updateChoice: process.env.DSH_E2E_UPDATE_CHOICE || '', preSettings: process.env.DSH_E2E_SETTINGS ? JSON.parse(process.env.DSH_E2E_SETTINGS) : null } : null,
}))

ipcMain.handle('settings:get', () => ({ ...settings }))
ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = ['host', 'port', 'cwd', 'checkUpdate', 'autoApplyUpdate', 'confirmQuit', 'lastUsedVersion', 'remoteEnabled', 'remotePort', 'remoteListen', 'language']
  for (const k of allowed) if (k in (patch || {})) settings[k] = patch[k]
  saveSettings()
  return { ...settings }
})

ipcMain.handle('env:check', async () => {
  envInfo = await detectNodeEnv()
  const lts = envInfo.ok ? null : await latestLtsVersion()
  return { ...envInfo, suggestedLts: lts }
})

ipcMain.handle('env:install', async () => {
  try {
    await installNode(({ phase, pct, msg }) => send('env:install-progress', { phase, pct, msg }))
    envInfo = await detectNodeEnv()
    return { ok: envInfo.ok, env: envInfo }
  } catch (err) {
    send('env:install-progress', { phase: 'error', pct: 0, msg: err.message })
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('dsh:start', (_e, opts) => handleStart(opts || {}))
ipcMain.handle('dsh:stop', async () => { await killDsh(); return true })
ipcMain.handle('dsh:state', () => ({ ...runState }))

ipcMain.handle('remote:info', () => {
  let token = ''
  try { token = runState.url ? new URL(runState.url).searchParams.get('token') || '' : '' } catch {}
  return {
    enabled: !!settings.remoteEnabled,
    port: settings.remotePort,
    listen: settings.remoteListen || '0.0.0.0',
    proxy: proxyState(),
    serviceRunning: runState.phase === 'running',
    token,
    ips: lanAddresses(),
  }
})
ipcMain.handle('remote:apply', () => applyRemote())

ipcMain.handle('ui:attach', () => {
  if (runState.phase === 'running' && runState.url) { attachAppView(); return true }
  return false
})
ipcMain.handle('ui:show-home', () => { detachAppView(); return true })

ipcMain.handle('ui:pick-cwd', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: T().pickCwdTitle,
    properties: ['openDirectory'],
    defaultPath: settings.cwd || os.homedir(),
  })
  if (canceled || !filePaths?.[0]) return null
  return filePaths[0]
})

ipcMain.handle('shell:open-external', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url)
  return true
})

ipcMain.handle('e2e:shot', async (_e, tag) => {
  if (!E2E || !win) return false
  try {
    await new Promise((r) => setTimeout(r, 600))
    const img = await win.webContents.capturePage()
    fs.writeFileSync(`/tmp/dsh-e2e-${tag}-shell.png`, img.toPNG())
    if (appView) {
      const vimg = await appView.webContents.capturePage()
      fs.writeFileSync(`/tmp/dsh-e2e-${tag}-app.png`, vimg.toPNG())
    }
    e2eMark('shot', { tag, children: win.contentView.children.length, hasView: !!appView })
  } catch (err) { e2eMark('shot-fail', { tag, err: err.message }) }
  return true
})

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

  app.whenReady().then(() => {
    loadSettings()
    buildMenu()
    createWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })

  app.on('before-quit', async (e) => {
    if (dshProc && !quitting) {
      e.preventDefault()
      quitting = true
      await killDsh()
      app.quit()
    }
  })
  app.on('window-all-closed', () => app.quit())
}
