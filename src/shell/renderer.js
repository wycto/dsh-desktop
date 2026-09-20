/**
 * renderer.js — 壳界面逻辑（傻瓜式：能点按钮解决的绝不碰命令行）
 */
const $ = (id) => document.getElementById(id)

const els = {
  envLine: $('env-line'),
  chip: $('status-chip'),
  btnBrowser: $('btn-open-browser'),
  btnHome: $('btn-home'),
  btnBack: $('btn-back'),
  btnStop: $('btn-stop'),
  paneInstall: $('pane-install'),
  paneHome: $('pane-home'),
  installVer: $('install-ver'),
  installDetail: $('install-detail'),
  btnInstall: $('btn-install'),
  installProgress: $('install-progress'),
  installBar: $('install-bar'),
  installMsg: $('install-msg'),
  installError: $('install-error'),
  btnManual: $('btn-manual'),
  inpHost: $('inp-host'),
  inpPort: $('inp-port'),
  inpCwd: $('inp-cwd'),
  btnPickCwd: $('btn-pick-cwd'),
  chkCheckUpdate: $('chk-check-update'),
  chkAutoUpdate: $('chk-auto-update'),
  errBanner: $('err-banner'),
  btnStart: $('btn-start'),
  statusCard: $('status-card'),
  statusTitle: $('status-title'),
  statusSub: $('status-sub'),
  statusSpinner: $('status-spinner'),
  elapsed: $('elapsed'),
  log: $('log'),
  btnCopyLog: $('btn-copy-log'),
  footer: $('footer-info'),
  chkRemote: $('chk-remote'),
  selRemoteListen: $('sel-remote-listen'),
  inpRemotePort: $('inp-remote-port'),
  remotePanel: $('remote-panel'),
  remoteQr: $('remote-qr'),
  remoteUrls: $('remote-urls'),
  btnCopyRemote: $('btn-copy-remote'),
  remoteError: $('remote-error'),
}

let appInfo = { version: '', platform: '', e2e: null }
let settings = {}
let envOk = false
let phase = 'idle' // idle | starting | running
let startedAt = 0
let elapsedTimer = null
let logLines = []
let installBusy = false
let e2eNavDone = false

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function log(stream, text) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  logLines.push(`[${time}] [${stream}] ${text}`)
  if (logLines.length > 800) logLines.splice(0, logLines.length - 800)
  els.log.textContent = logLines.join('\n')
  const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 60
  if (nearBottom) els.log.scrollTop = els.log.scrollHeight
}

function showErr(msg) {
  els.errBanner.textContent = msg
  els.errBanner.classList.remove('hidden')
}
function hideErr() { els.errBanner.classList.add('hidden') }

function setChip(state) {
  els.chip.className = 'chip ' + ({ idle: 'chip-idle', starting: 'chip-starting', running: 'chip-running' }[state] || 'chip-idle')
  els.chip.textContent = { idle: '未启动', starting: '启动中…', running: '运行中' }[state] || '未启动'
}

function setHeaderButtons() {
  els.btnStop.classList.toggle('hidden', phase === 'idle')
  els.btnBrowser.classList.toggle('hidden', phase !== 'running')
  // “设置”按钮：只有内嵌页显示中（home 面板隐藏）时出现
  els.btnHome.classList.toggle('hidden', !(phase === 'running' && els.paneHome.classList.contains('hidden')))
  const homeVisible = !els.paneHome.classList.contains('hidden')
  // 返回页面按钮：服务运行中且当前停留在设置页
  els.btnBack.classList.toggle('hidden', !(phase === 'running' && homeVisible))
  els.btnStart.textContent = phase === 'running' && homeVisible ? '重启服务（应用新配置）'
    : phase === 'idle' ? '启动服务' : phase === 'starting' ? '启动中…' : '运行中'
  els.btnStart.disabled = phase === 'starting' || (phase === 'running' && !homeVisible)
}

function startElapsed() {
  startedAt = Date.now()
  clearInterval(elapsedTimer)
  elapsedTimer = setInterval(() => {
    els.elapsed.textContent = Math.floor((Date.now() - startedAt) / 1000) + 's'
  }, 500)
}
function stopElapsed() { clearInterval(elapsedTimer) }

// ---------------------------------------------------------------------------
// 面板切换
// ---------------------------------------------------------------------------

function showInstallPane(info) {
  els.paneHome.classList.add('hidden')
  els.paneInstall.classList.remove('hidden')
  els.envLine.textContent = `v${appInfo.version} · 未检测到 Node.js / npm`
  if (info?.suggestedLts) els.installVer.textContent = `v${info.suggestedLts} LTS`
  if (info?.detail) {
    els.installDetail.textContent = info.detail
    els.installDetail.classList.remove('hidden')
  }
}

function showHomePane() {
  els.paneInstall.classList.add('hidden')
  els.paneHome.classList.remove('hidden')
}

async function refreshEnv({ silent = false } = {}) {
  const info = await window.dsh.envCheck()
  envOk = !!info.ok
  if (envOk) {
    showHomePane()
    els.envLine.textContent = `v${appInfo.version} · Node ${info.nodeVersion || '?'} · npm ${info.npmVersion || '?'}`
    els.footer.textContent = `DSH Desktop v${appInfo.version} · Node ${info.nodeVersion || '?'} · npm ${info.npmVersion || '?'}`
  } else {
    showInstallPane(info)
  }
  if (!silent) log('shell', `[壳] 环境检测：${envOk ? `node ${info.nodeVersion} @ ${info.nodeDir}` : '未找到 Node.js/npm'}`)
  return info
}

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

async function doStart() {
  hideErr()
  const host = els.inpHost.value.trim() || '127.0.0.1'
  const port = parseInt(els.inpPort.value, 10)
  const cwd = els.inpCwd.value.trim() || settings.cwd
  if (!/^[a-zA-Z0-9.\-_]+$/.test(host)) { showErr('监听 IP 格式不正确，例如 127.0.0.1'); return }
  if (host === '0.0.0.0') { showErr('dsh 不支持绑定 0.0.0.0（对外暴露远程执行风险），请使用 127.0.0.1 或 localhost'); return }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { showErr('端口必须是 1 – 65535 的数字'); return }

  await window.dsh.saveSettings({ host, port, cwd, checkUpdate: els.chkCheckUpdate.checked, autoApplyUpdate: els.chkAutoUpdate.checked })

  const restart = phase === 'running'
  if (restart) log('shell', '[壳] 重启 dsh 以应用新配置…')
  phase = 'starting'
  setChip('starting')
  setHeaderButtons()
  els.statusCard.classList.remove('hidden')
  els.statusTitle.textContent = restart ? '正在重启…' : '正在启动…'
  els.statusSub.textContent = '正在检查 dsh 版本与运行环境'
  startElapsed()
  log('shell', `[壳] 请求启动：host=${host} port=${port} cwd=${cwd}`)

  const res = await window.dsh.start({ host, port, cwd, checkUpdate: els.chkCheckUpdate.checked, autoApplyUpdate: els.chkAutoUpdate.checked })
  if (!res.ok) {
    phase = 'idle'
    setChip('idle')
    setHeaderButtons()
    els.statusCard.classList.add('hidden')
    stopElapsed()
    if (res.needInstall) {
      log('shell', '[壳] 缺少 Node.js 环境，转入安装引导')
      const info = await refreshEnv()
      if (!info.ok) return
      // 装好后环境其实已可用，这里直接重新启动
      return doStart()
    }
    showErr(res.reason || '启动失败')
    return
  }
  els.statusTitle.textContent = '正在启动 dsh…'
  els.statusSub.textContent = '首次启动需要下载较多组件，可能需要几分钟，请耐心等待；详细进度见下方运行日志'
}

async function doStop() {
  phase = 'idle'
  setChip('idle')
  setHeaderButtons()
  els.statusCard.classList.add('hidden')
  stopElapsed()
  showHomePane()
  log('shell', '[壳] 正在停止 dsh…')
  await window.dsh.stop()
}

async function onStatus(s) {
  if (s.phase === 'running' && s.url) {
    phase = 'running'
    setChip('running')
    stopElapsed()
    els.statusCard.classList.add('hidden')
    if (s.embedded !== false) {
      // 内嵌页已挂载，把主面板藏到下面（主页面按钮可随时回来）
      els.paneHome.classList.add('hidden')
    }
    setHeaderButtons()
    if (appInfo.e2e) {
      setTimeout(() => window.dsh.e2eShot('app-loaded'), 3500)
      setTimeout(() => e2eNavTest(), 6000)
    }
    refreshRemote()
  } else if (s.phase === 'starting') {
    phase = 'starting'
    setChip('starting')
    setHeaderButtons()
  } else if (s.phase === 'idle') {
    phase = 'idle'
    setChip('idle')
    stopElapsed()
    els.statusCard.classList.add('hidden')
    showHomePane()
    setHeaderButtons()
    if (s.error) showErr(s.error)
    refreshRemote()
  }
}

// ---------------------------------------------------------------------------
// 手机 / 局域网访问
// ---------------------------------------------------------------------------

let lastRemoteUrls = []
let selectedRemoteUrl = ''

function makeQrSvg(text) {
  try {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true })
  } catch { return '' }
}

function buildRemoteUrls(info) {
  const listen = info.listen || '0.0.0.0'
  if (listen !== '0.0.0.0') return [`http://${listen}:${info.port}/?token=${info.token}`]
  return (info.ips || []).map((ip) => `http://${ip}:${info.port}/?token=${info.token}`)
}

async function refreshRemote() {
  const info = await window.dsh.remoteInfo().catch(() => null)
  if (!info) return
  const active = info.enabled && info.serviceRunning && info.proxy.running && !!info.token
  els.remotePanel.classList.toggle('hidden', !active)
  els.remoteError.classList.toggle('hidden', !info.proxy.error)
  if (info.proxy.error) els.remoteError.textContent = `转发服务启动失败：${info.proxy.error}。可以换一个访问端口后重试。`

  // 监听范围下拉（保留当前选择，探测到新网卡时刷新选项）
  const listen = info.listen || '0.0.0.0'
  const options = ['0.0.0.0', ...(info.ips || [])]
  const current = els.selRemoteListen.value || listen
  els.selRemoteListen.replaceChildren(...options.map((ip) => {
    const o = document.createElement('option')
    o.value = ip
    o.textContent = ip === '0.0.0.0' ? '所有网卡（默认）' : `仅 ${ip}`
    return o
  }))
  els.selRemoteListen.value = options.includes(current) ? current : listen

  lastRemoteUrls = active ? buildRemoteUrls(info) : []
  if (!lastRemoteUrls.includes(selectedRemoteUrl)) selectedRemoteUrl = lastRemoteUrls[0] || ''
  els.remoteUrls.replaceChildren(...lastRemoteUrls.map((u) => {
    const d = document.createElement('div')
    d.className = 'remote-url' + (u === selectedRemoteUrl ? ' active' : '')
    d.textContent = u
    d.title = '点击切换二维码到该地址'
    d.addEventListener('click', () => {
      selectedRemoteUrl = u
      els.remoteQr.innerHTML = makeQrSvg(selectedRemoteUrl)
      for (const n of els.remoteUrls.children) n.classList.toggle('active', n.textContent === selectedRemoteUrl)
    })
    return d
  }))
  if (!lastRemoteUrls.length && active) {
    const none = document.createElement('div')
    none.className = 'muted small'
    none.textContent = '未发现局域网网卡地址'
    els.remoteUrls.appendChild(none)
  }
  els.remoteQr.innerHTML = selectedRemoteUrl ? makeQrSvg(selectedRemoteUrl) : ''
}

// ---------------------------------------------------------------------------
// Node 安装引导
// ---------------------------------------------------------------------------

/** E2E：验证 设置页 ↔ 内嵌页 往返。 */
async function e2eNavTest() {
  if (e2eNavDone) return
  e2eNavDone = true
  log('shell', '[e2e] 导航测试：切到设置页')
  await window.dsh.showHome()
  showHomePane()
  setHeaderButtons()
  window.dsh.e2eShot('home-while-running')
  await new Promise((r) => setTimeout(r, 900))
  log('shell', '[e2e] 导航测试：返回内嵌页')
  const ok = await window.dsh.attachApp()
  if (ok) els.paneHome.classList.add('hidden')
  setHeaderButtons()
  window.dsh.e2eShot('back-to-app')
}

async function doInstall() {
  if (installBusy) return
  installBusy = true
  els.btnInstall.disabled = true
  els.installProgress.classList.remove('hidden')
  els.installError.classList.add('hidden')
  els.installBar.style.width = '2%'
  els.installMsg.textContent = '准备中…'
  log('shell', '[壳] 开始安装 Node.js（官方 LTS 版本）…')

  const res = await window.dsh.envInstall()
  if (res.ok) {
    els.installBar.style.width = '100%'
    els.installMsg.textContent = '安装完成，正在初始化…'
    await new Promise((r) => setTimeout(r, 800))
    const info = await refreshEnv()
    if (info.ok) {
      log('shell', `[壳] Node.js 安装完成：node ${info.nodeVersion} @ ${info.nodeDir}`)
      // 安装完成后自动回到主面板（由 refreshEnv 完成切面板）
      if (appInfo.e2e) window.dsh.e2eShot('install-done')
    }
  } else {
    const reason = res.error
      || (res.env ? '安装完成但未能检测到新环境，请退出本程序重新打开' : '未知错误')
    els.installError.textContent = `自动安装失败：${reason}。可点击下方链接手动下载安装；装好后重新打开本程序即可。`
    els.installError.classList.remove('hidden')
    els.btnInstall.disabled = false
    log('shell', `[壳] Node.js 安装失败：${reason}`)
    if (appInfo.e2e) window.dsh.e2eShot('install-error')
  }
  installBusy = false
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

els.btnStart.addEventListener('click', doStart)
els.btnStop.addEventListener('click', doStop)
els.btnHome.addEventListener('click', async () => {
  // 回到设置页：摘掉内嵌视图
  await window.dsh.showHome()
  showHomePane()
  setHeaderButtons()
})
els.btnBack.addEventListener('click', async () => {
  // 重新挂上内嵌页
  const ok = await window.dsh.attachApp()
  if (ok) {
    els.paneHome.classList.add('hidden')
  } else {
    showErr('dsh 尚未运行，无法返回页面')
  }
  setHeaderButtons()
})
els.btnBrowser.addEventListener('click', async () => {
  const st = await window.dsh.state()
  if (st.url) window.dsh.openExternal(st.url)
})
els.btnPickCwd.addEventListener('click', async () => {
  const dir = await window.dsh.pickCwd()
  if (dir) els.inpCwd.value = dir
})
els.btnInstall.addEventListener('click', doInstall)
els.btnManual.addEventListener('click', (e) => {
  e.preventDefault()
  window.dsh.openExternal('https://nodejs.org/zh-cn/download')
})
els.btnCopyLog.addEventListener('click', async () => {
  await navigator.clipboard.writeText(logLines.join('\n')).catch(() => {})
  els.btnCopyLog.textContent = '已复制'
  setTimeout(() => { els.btnCopyLog.textContent = '复制日志' }, 1500)
})
els.chkRemote.addEventListener('change', async () => {
  await window.dsh.saveSettings({ remoteEnabled: els.chkRemote.checked })
  await window.dsh.remoteApply()
  refreshRemote()
})
els.inpRemotePort.addEventListener('change', async () => {
  const port = parseInt(els.inpRemotePort.value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return
  await window.dsh.saveSettings({ remotePort: port })
  await window.dsh.remoteApply()
  refreshRemote()
})
els.selRemoteListen.addEventListener('change', async () => {
  await window.dsh.saveSettings({ remoteListen: els.selRemoteListen.value })
  await window.dsh.remoteApply()
  refreshRemote()
})
els.btnCopyRemote.addEventListener('click', async () => {
  if (!selectedRemoteUrl) return
  await navigator.clipboard.writeText(selectedRemoteUrl).catch(() => {})
  els.btnCopyRemote.textContent = '已复制'
  setTimeout(() => { els.btnCopyRemote.textContent = '复制选中地址' }, 1500)
})

window.dsh.on('log', (d) => log(d.stream === 'err' ? 'stderr' : d.stream === 'shell' ? 'shell' : 'stdout', d.text))
window.dsh.on('status', onStatus)
window.dsh.on('remoteState', () => refreshRemote())
window.dsh.on('installProgress', (p) => {
  els.installBar.style.width = `${Math.max(2, p.pct || 0)}%`
  els.installMsg.textContent = p.msg || ''
  log('shell', `[安装] ${p.msg || ''}`)
  if (p.phase === 'error') {
    els.installError.textContent = `自动安装失败：${p.msg}。可点击下方链接手动下载安装；装好后重新打开本程序即可。`
    els.installError.classList.remove('hidden')
    els.btnInstall.disabled = false
    installBusy = false
    if (appInfo.e2e) window.dsh.e2eShot('install-error')
  }
})

// ---------------------------------------------------------------------------
// 启动流程
// ---------------------------------------------------------------------------

async function boot() {
  appInfo = await window.dsh.appInfo()
  settings = await window.dsh.getSettings()
  els.inpHost.value = settings.host || '127.0.0.1'
  els.inpPort.value = settings.port || 8080
  els.inpCwd.value = settings.cwd || ''
  els.chkCheckUpdate.checked = settings.checkUpdate !== false
  els.chkAutoUpdate.checked = !!settings.autoApplyUpdate
  els.chkRemote.checked = !!settings.remoteEnabled
  els.inpRemotePort.value = settings.remotePort || 8688
  refreshRemote()
  log('shell', `[壳] DSH Desktop v${appInfo.version} 启动`)

  const st = await window.dsh.state()
  if (st.phase === 'running' && st.url) {
    phase = 'running'
    setChip('running')
    els.paneHome.classList.add('hidden') // 主进程已挂载内嵌页
    log('shell', '[壳] 检测到 dsh 已在运行，已恢复页面')
  } else {
    setChip(st.phase)
  }
  setHeaderButtons()

  await refreshEnv({ silent: true })

  // E2E 自动化脚本
  if (appInfo.e2e) {
    window.dsh.e2eShot('boot')
    if (!envOk) {
      log('shell', '[e2e] 环境缺失，自动触发一键安装流程')
      await doInstall()
      return
    }
    if (appInfo.e2e.preSettings) {
      await window.dsh.saveSettings(appInfo.e2e.preSettings)
      els.inpHost.value = appInfo.e2e.preSettings.host || els.inpHost.value
      els.inpPort.value = appInfo.e2e.preSettings.port || els.inpPort.value
      if (appInfo.e2e.preSettings.remoteEnabled !== undefined) els.chkRemote.checked = !!appInfo.e2e.preSettings.remoteEnabled
      if (appInfo.e2e.preSettings.remotePort !== undefined) els.inpRemotePort.value = appInfo.e2e.preSettings.remotePort
    }
    await new Promise((r) => setTimeout(r, 400))
    doStart()
  }
}

boot()
