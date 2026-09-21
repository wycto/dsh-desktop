/**
 * nodeenv.mjs — Node.js 环境检测与一键安装（主进程模块）
 *
 * 设计要点：
 * - macOS/Windows 图形界面启动的应用 PATH 很短，不能用 `which npm` 一票否决，
 *   必须扫描常见安装位置（官方 pkg/msi、Homebrew、nvm、volta、scoop、fnm、~/.local/bin 等），
 *   再辅以用户 shell 的 `command -v` 兜底。
 * - 找到的目录都要实际跑 `node -v` / `npm -v` 验证可用，避免 PATH 上的坏符号链接。
 * - 安装走 nodejs.org 官方安装包：macOS 用 pkg + osascript 管理员提权静默安装，
 *   Windows 用 msi + PowerShell RunAs（UAC 弹窗点“是”即可），全程用户只点确认。
 */
import { spawn, execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'

export const FALLBACK_LTS = '22.21.1' // nodejs.org/dist/index.json 不可达时的兜底 LTS 版本
export const NODE_DIST_BASE = 'https://nodejs.org/dist'

const WIN = process.platform === 'win32'
const EXE = WIN ? '.exe' : ''

function run(cmd, args, { timeout = 10000, env, cwd } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { child.kill('SIGKILL') } catch {}
      resolve(null)
    }, timeout)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(null) } })
    child.on('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(code === 0 ? out : null)
    })
  })
}

/** 读取用户 npm 配置的 registry（尊重国内镜像），失败返回官方源。 */
export async function detectRegistry(nodeDir) {
  const fallback = 'https://registry.npmjs.org'
  try {
    const npmCli = npmCliJs(nodeDir)
    const out = await run(nodeExePath(nodeDir), [npmCli, 'config', 'get', 'registry'], { timeout: 8000 })
    const url = (out || '').trim().split(/\r?\n/).pop()?.trim()
    if (url && /^https?:\/\//i.test(url)) return url.replace(/\/+$/, '')
  } catch {}
  return fallback
}

function nodeExePath(dir) { return path.join(dir, `node${EXE}`) }
function npmCmdPath(dir) { return path.join(dir, WIN ? 'npm.cmd' : 'npm') }
function npmCliJs(dir) {
  return path.join(dir, WIN ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js')
}
function npxCliJs(dir) {
  return path.join(dir, WIN ? 'node_modules/npm/bin/npx-cli.js' : '../lib/node_modules/npm/bin/npx-cli.js')
}

function sortVersionDesc(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number)
  const pb = String(b).replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] || 0) - (pa[i] || 0)
    if (d) return d
  }
  return 0
}

/** 按平台列出候选目录（可能有 node 的地方）。 */
export function candidateDirs() {
  const h = os.homedir()
  const dirs = []
  if (WIN) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const appdata = process.env['APPDATA'] || path.join(h, 'AppData', 'Roaming')
    const local = process.env['LOCALAPPDATA'] || path.join(h, 'AppData', 'Local')
    dirs.push(
      path.join(pf, 'nodejs'),
      path.join(pf86, 'nodejs'),
      path.join(local, 'Volta', 'bin'),
      path.join(h, 'scoop', 'apps', 'nodejs', 'current'),
      path.join(h, 'scoop', 'shims'),
      path.join(h, '.local', 'bin'),
      path.join(appdata, 'npm'),
    )
    // nvm-windows: %APPDATA%\nvm\vXX.X.X
    const nvmRoot = path.join(appdata, 'nvm')
    try {
      const vers = fs.readdirSync(nvmRoot).filter((n) => /^v?\d/.test(n) && fs.existsSync(path.join(nvmRoot, n, `node${EXE}`)))
      vers.sort(sortVersionDesc)
      for (const v of vers) dirs.push(path.join(nvmRoot, v))
    } catch {}
    // fnm
    try {
      const fnmRoot = path.join(local, 'fnm_multishells')
      for (const d of fs.readdirSync(fnmRoot)) dirs.push(path.join(fnmRoot, d))
    } catch {}
  } else {
    dirs.push(
      '/usr/local/bin',
      '/opt/homebrew/bin',
      path.join(h, '.local', 'bin'),
      path.join(h, '.volta', 'bin'),
      path.join(h, 'bin'),
      '/opt/local/bin',
      '/usr/bin',
    )
    // nvm：取最高版本
    const nvmRoot = path.join(h, '.nvm', 'versions', 'node')
    try {
      const vers = fs.readdirSync(nvmRoot).filter((n) => /^v\d/.test(n) && fs.existsSync(path.join(nvmRoot, n, 'bin', 'node')))
      vers.sort(sortVersionDesc)
      for (const v of vers) dirs.push(path.join(nvmRoot, v, 'bin'))
    } catch {}
    // fnm
    for (const p of [path.join(h, '.local', 'share', 'fnm'), path.join(h, 'Library', 'Application Support', 'fnm')]) {
      try {
        for (const d of fs.readdirSync(p)) {
          const bin = path.join(p, d, 'installation', 'bin')
          if (fs.existsSync(path.join(bin, 'node'))) dirs.push(bin)
        }
      } catch {}
    }
    // asdf
    try {
      for (const d of fs.readdirSync(path.join(h, '.asdf', 'installs', 'nodejs'))) {
        const bin = path.join(h, '.asdf', 'installs', 'nodejs', d, 'bin')
        if (fs.existsSync(path.join(bin, 'node'))) dirs.push(bin)
      }
    } catch {}
  }
  return [...new Set(dirs)]
}

async function validateDir(dir) {
  const nodeP = nodeExePath(dir)
  const npxJs = npxCliJs(dir)
  const okFs = fs.existsSync(nodeP) && (fs.existsSync(npxJs) || fs.existsSync(npmCmdPath(dir)))
  if (!okFs) return null
  const vOut = await run(nodeP, ['-v'], { timeout: 10000 })
  const nodeVersion = vOut?.trim().split(/\r?\n/)[0]?.trim()
  if (!nodeVersion || !/^v\d/.test(nodeVersion)) return null
  let npmVersion = ''
  const npmJs = npmCliJs(dir)
  if (fs.existsSync(npmJs)) {
    const nOut = await run(nodeP, [npmJs, '-v'], { timeout: 15000 })
    npmVersion = (nOut || '').trim().split(/\r?\n/).pop()?.trim() || ''
  }
  const finalNpxJs = fs.existsSync(npxJs) ? npxJs : null
  if (!finalNpxJs) return null
  return {
    ok: true,
    nodeDir: dir,
    nodePath: nodeP,
    npxCliJs: finalNpxJs,
    nodeVersion,
    npmVersion,
    source: 'scan',
  }
}

/** 用登录 shell 兜底找 node（覆盖自定义安装路径）。 */
async function shellFallback() {
  const tries = WIN
    ? [['cmd.exe', ['/c', 'where', 'node']]]
    : [
        ['/bin/zsh', ['-l', '-i', '-c', 'command -v node || true']],
        ['/bin/bash', ['-l', '-c', 'command -v node || true']],
      ]
  for (const [cmd, args] of tries) {
    const out = await run(cmd, args, { timeout: 7000 })
    if (!out) continue
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    for (const line of lines) {
      if (!fs.existsSync(line)) continue
      if (WIN) {
        // where 可能返回多个；确认是 node.exe 而非 bash shim 文本
        if (/node(\.exe)?$/i.test(line)) {
          const dir = path.dirname(line)
          const r = await validateDir(dir)
          if (r) return { ...r, source: 'shell' }
        }
      } else if (fs.statSync(line).isFile()) {
        // 可能是符号链接
        const real = fs.realpathSync(line)
        const dir = path.dirname(real)
        const r = await validateDir(dir)
        if (r) return { ...r, source: 'shell' }
      }
    }
  }
  return null
}

/** 检测结果（含 npm registry）。 */
export async function detectNodeEnv() {
  const fake = process.env.DSH_E2E_FAKE_NO_NODE === '1'
  for (const dir of candidateDirs()) {
    if (fake) break
    const r = await validateDir(dir)
    if (r) return { ...r, registry: await detectRegistry(r.nodeDir) }
  }
  if (!fake) {
    const r = await shellFallback()
    if (r) return { ...r, registry: await detectRegistry(r.nodeDir) }
  }
  return { ok: false }
}

/** 启动 dsh 子进程要用的环境变量（把 node 目录放到 PATH 最前）。 */
export function spawnEnv(nodeDir, extraDirs = []) {
  const env = { ...process.env }
  const prefix = [...new Set([...(extraDirs.filter(Boolean)), nodeDir].filter(Boolean))]
  if (prefix.length) env.PATH = prefix.join(path.delimiter) + path.delimiter + (env.PATH || '')
  return env
}

// ---------------------------------------------------------------------------
// pnpm 检测与自动安装（dsh plugin 内部 spawnSync("pnpm")，只认 PATH 上的命令）
// ---------------------------------------------------------------------------

// 用固定版本而非 @latest：安装是“环境保障”不是“尝鲜”，钉住避免上游发版
// 带新问题影响所有用户。独立二进制来自官方 @pnpm/<平台> 包，内置 Node，
// 装到 ~/.dsh/bin，不写系统目录、不需要管理员权限。
const PNPM_VERSION = '10.34.5'
// dsh-dock 的安装依赖 package.json 里的 pnpm.overrides（v8 起支持）与
// --config.* 参数，过旧的 pnpm 装不上；达不到要求就装独立版（不动用户的）
const PNPM_MIN_VERSION = '9.0.0'
// @pnpm/<平台>@<版本> 的 sha512 完整性校验值（来自 npm registry dist.integrity）
const PNPM_INTEGRITY = {
  'linux-x64': 'sha512-blNFcW3EVmOkeZYnkY5lraD1+oqiFvSByMT3GTRGKp7P7C4PtHixLQJLe2AzJ4rLimFjgqfHg0Cf/Si/9bZlHQ==',
  'linux-arm64': 'sha512-sV8iFna/MN7BMDuBmAEJqhzlywAoJ8LXXjrMR3IkeoDtP9PBY5j/AkGHa9woVDZMAEIAMxWV7sBnyPxiN5ByGA==',
  'darwin-x64': 'sha512-KrvYm3ArCMCT/rZnBUYPC6phvWxowpgJzIa/19UY4/2GL0L4CGUX8sGB30qI1lae1numn/6s2VkSCFF4VrZuyg==',
  'darwin-arm64': 'sha512-Uxvslz0yx/IICmP0EoGs+H9j4cA3JXV0mjtvAOisht0y/FCjS1GkGj8BA+EudDwmc9vsgtOrnq6tRFRluCsIsA==',
  'win32-x64': 'sha512-bMjuj4KrPeqLqb66AS1ABqbbjow3JW0odFil70HC+PAwVM0meACH2Alv3IfrrxKgoO/yqCpOIttesT/tVbsOSA==',
  'win32-arm64': 'sha512-r7fdkZEmIJzXXZMrOfu2j2sUmLlLvuXVJ48NER6bT/UtaIIZYXTUNy6/ejYLxf2PBqyOruhjYmVqkJthk6v1yA==',
}

/** pnpm 独立二进制的安装目录（用户目录内；加入子进程 PATH）。 */
export function pnpmBinDir() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'bin')
}

/** semver 只比较前三段数字，a ≥ min 返回 true。 */
function versionAtLeast(v, min) {
  const a = String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const b = String(min).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d > 0 }
  return true
}

/** 实际跑 `pnpm -v` 验证可用，返回版本号或 null（PATH 上可能有坏 shim）。 */
async function pnpmVersionAt(exe) {
  const out = WIN && !/\.exe$/i.test(exe)
    ? await run('cmd.exe', ['/c', exe, '-v'], { timeout: 15000 })
    : await run(exe, ['-v'], { timeout: 15000 })
  const v = (out || '').trim().split(/\r?\n/).pop()?.trim()
  return /^v?\d+\.\d+/.test(v || '') ? v.replace(/^v/, '') : null
}

/** 找系统里已有的 pnpm（shell PATH 优先，常见位置兜底），返回 {exe,version} 或 null。 */
async function findExistingPnpm() {
  const h = os.homedir()
  const exeName = WIN ? 'pnpm.exe' : 'pnpm'
  const candidates = [
    // 我们自己装的独立版（后续启动走这条，秒回）
    path.join(pnpmBinDir(), exeName),
    path.join(h, '.local', 'bin', 'pnpm'),
    path.join(h, 'Library', 'pnpm', 'pnpm'),
  ]
  if (process.env.PNPM_HOME) candidates.push(path.join(process.env.PNPM_HOME, exeName))
  if (WIN) candidates.push(path.join(process.env['APPDATA'] || path.join(h, 'AppData', 'Roaming'), 'npm', 'pnpm.cmd'))
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    const v = await pnpmVersionAt(p)
    if (v) return { exe: p, version: v }
  }
  // 用户 shell 的 PATH（图形界面启动时 process.env.PATH 往往不全）
  const tries = WIN
    ? [['cmd.exe', ['/c', 'where', 'pnpm']]]
    : [
        ['/bin/zsh', ['-l', '-i', '-c', 'command -v pnpm || true']],
        ['/bin/bash', ['-l', '-c', 'command -v pnpm || true']],
      ]
  for (const [cmd, args] of tries) {
    const out = await run(cmd, args, { timeout: 8000 })
    for (const line of (out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (!fs.existsSync(line)) continue
      const v = await pnpmVersionAt(line)
      if (v) return { exe: line, version: v }
    }
  }
  return null
}

/** 当前平台对应的 @pnpm/<平台> 包名后缀，没有独立二进制的平台返回 null。 */
function pnpmPlatform() {
  const osName = { win32: 'win', darwin: 'macos', linux: 'linux' }[process.platform]
  if (!osName) return null
  const key = `${process.platform}-${process.arch}`
  return PNPM_INTEGRITY[key] ? `${osName}-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : null
}

/**
 * 确保能给 dsh 提供可用的 pnpm：先检测已有安装（版本要达标），
 * 没有就从用户已配置的 npm registry（尊重国内镜像）下载官方独立二进制
 * 装到 ~/.dsh/bin 并 chmod +x。不改动用户自己的 pnpm。
 * @param {string} nodeDir 已检测到的 Node 目录（用于查 registry）
 * @param {(text: string) => void} log 往壳日志写一行
 * @returns {Promise<{ok: boolean, pnpmDir: string}>} pnpmDir 要前置到子进程 PATH
 */
export async function ensurePnpm(nodeDir, log = () => {}) {
  const binDir = pnpmBinDir()
  const found = process.env.DSH_DESKTOP_FORCE_PNPM_INSTALL === '1' ? null : await findExistingPnpm()
  if (found && versionAtLeast(found.version, PNPM_MIN_VERSION)) {
    return { ok: true, pnpmDir: path.dirname(found.exe) }
  }
  if (found) log(`[壳] 检测到 pnpm v${found.version} 过旧（需 ≥ ${PNPM_MIN_VERSION}），将为 dsh 单独安装 pnpm v${PNPM_VERSION}`)

  const plat = pnpmPlatform()
  if (!plat) {
    log(`[壳] 当前平台（${process.platform}-${process.arch}）没有 pnpm 独立二进制，无法自动安装`)
    return { ok: false, pnpmDir: found ? path.dirname(found.exe) : '' }
  }
  log(`[壳] 未找到可用的 pnpm，正在自动安装官方独立版 pnpm v${PNPM_VERSION} 到 ${binDir} …`)
  try {
    const registry = await detectRegistry(nodeDir)
    const url = `${registry}/@pnpm/${plat}/-/${plat}-${PNPM_VERSION}.tgz`
    const dest = path.join(binDir, WIN ? 'pnpm.exe' : 'pnpm')
    await fsp.mkdir(binDir, { recursive: true })
    await downloadVerified(url, dest, PNPM_INTEGRITY[`${process.platform}-${process.arch}`])
    if (!WIN) await fsp.chmod(dest, 0o755)
    const v = await pnpmVersionAt(dest)
    if (!v) throw new Error('安装后 pnpm 无法运行')
    log(`[壳] pnpm v${v} 安装完成`)
    return { ok: true, pnpmDir: binDir }
  } catch (err) {
    log(`[壳] pnpm 自动安装失败：${err.message}（不影响 dsh 启动，仅插件自动安装与手机端新版布局可能缺失）`)
    return { ok: false, pnpmDir: found ? path.dirname(found.exe) : '' }
  }
}

/**
 * 下载 npm 包 tgz，校验 sha512 后解出包内二进制写到 dest。
 * tgz 结构固定为 package/<name>（pnpm 官方 @pnpm/<平台> 包只有一个可执行文件）。
 */
async function downloadVerified(url, dest, want) {
  const tmp = dest + '.part'
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const tgz = Buffer.from(await resp.arrayBuffer())
      if (want) {
        const got = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64')
        if (got !== want) throw new Error('sha512 校验失败（下载不完整或被篡改）')
      }
      const bin = extractTarGzEntry(tgz, 'package/pnpm')
      if (!bin?.length) throw new Error('tgz 里没有找到 pnpm 二进制')
      await fsp.writeFile(tmp, bin)
      await fsp.rename(tmp, dest)
      return
    } catch (err) {
      try { await fsp.rm(tmp, { force: true }) } catch {}
      if (attempt === 3) throw err
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
}

/**
 * 从内存 tgz 解出指定条目（gunzip + 手工解析 ustar 头，只读不落盘）。
 * 只处理普通文件条目；GNU 长名/链接条目直接跳过（@pnpm 的包用不到）。
 */
function extractTarGzEntry(tgz, entryName) {
  try {
    const tar = zlib.gunzipSync(tgz)
    let off = 0
    while (off + 512 <= tar.length) {
      const header = tar.subarray(off, off + 512)
      if (header.every((b) => b === 0)) break // 结束块
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
      const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8) || 0
      const type = String.fromCharCode(header[156] || 48)
      const dataOff = off + 512
      if (type === '0' || type === '\0') { // 普通文件（链接/长名条目直接跳过，@pnpm 包用不到）
        if (name === entryName) return tar.subarray(dataOff, dataOff + size)
      }
      off = dataOff + Math.ceil(size / 512) * 512
    }
  } catch {}
  return null
}

// ---------------------------------------------------------------------------
// 一键安装
// ---------------------------------------------------------------------------

export async function latestLtsVersion() {
  try {
    const resp = await fetch(`${NODE_DIST_BASE}/index.json`, { signal: AbortSignal.timeout(15000) })
    if (resp.ok) {
      const list = await resp.json()
      const lts = list.find((e) => e.lts)
      if (lts?.version) return lts.version.replace(/^v/, '')
    }
  } catch {}
  return FALLBACK_LTS
}

/** 下载文件，onProgress({received,total,pct})。兼容 Node 流与 Web 流两种响应体。 */
async function download(url, dest, onProgress) {
  const tmp = dest + '.part'
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 不设超时：安装包近百 MB，慢网络下耗时很长；失败由重试逻辑兜底
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const total = Number(resp.headers.get('content-length') || 0)
      const nodeStream = typeof resp.body?.on === 'function'
        ? resp.body
        : Readable.fromWeb(resp.body)
      const ws = fs.createWriteStream(tmp)
      let received = 0
      await new Promise((resolve, reject) => {
        ws.on('error', reject)
        nodeStream.on('error', reject)
        nodeStream.on('data', (chunk) => {
          received += chunk.length
          onProgress?.({ received, total, pct: total ? Math.floor((received / total) * 100) : 0 })
          if (!ws.write(chunk)) {
            nodeStream.pause()
            ws.once('drain', () => nodeStream.resume())
          }
        })
        nodeStream.on('end', () => ws.end(resolve))
      })
      const size = fs.statSync(tmp).size
      if (size < 1024 * 1024) throw new Error(`下载文件过小(${size} bytes)`)
      await fsp.rename(tmp, dest)
      return dest
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }) } catch {}
      if (attempt === 3) throw err
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
}

function quoteShell(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * 安装 Node.js LTS。onProgress({phase, pct, msg}) 供 UI 展示。
 * 返回安装是否成功（成功后调用方需要重新 detectNodeEnv）。
 * DSH_DESKTOP_INSTALL_DRYRUN=1 时跳过真正写系统，用于测试。
 */
export async function installNode(onProgress = () => {}) {
  const version = await latestLtsVersion()
  const arch = WIN ? (process.arch === 'arm64' ? 'arm64' : 'x64') : 'universal'
  const base = `node-v${version}`
  const fname = WIN ? `${base}-${arch}.msi` : `${base}.pkg`
  const url = `${NODE_DIST_BASE}/v${version}/${fname}`
  const tmpDir = path.join(os.tmpdir(), 'dsh-desktop-node-install')
  await fsp.mkdir(tmpDir, { recursive: true })
  const dest = path.join(tmpDir, fname)

  onProgress({ phase: 'download', pct: 0, msg: `正在下载 Node.js v${version} 官方安装包…` })
  await download(url, dest, ({ pct }) => {
    onProgress({ phase: 'download', pct, msg: `正在下载 Node.js v${version} 官方安装包… ${pct}%` })
  })

  if (process.env.DSH_DESKTOP_INSTALL_DRYRUN === '1') {
    onProgress({ phase: 'install', pct: 50, msg: '（测试模式）跳过真实安装' })
    await new Promise((r) => setTimeout(r, 1200))
    onProgress({ phase: 'done', pct: 100, msg: '安装完成' })
    await fsp.rm(dest, { force: true }).catch(() => {})
    return true
  }

  if (WIN) {
    onProgress({ phase: 'install', pct: 60, msg: '正在安装（如系统弹出用户账户控制窗口，请点击“是”）…' })
    const ps = [
      `$p = Start-Process msiexec -ArgumentList '/i',${quoteWin(dest)},'/qn','/norestart' -Verb RunAs -Wait -PassThru;`,
      'exit $p.ExitCode',
    ].join(' ')
    const code = await new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        stdio: 'ignore', windowsHide: true,
      })
      child.on('error', () => resolve(-1))
      child.on('exit', (c) => resolve(c ?? -1))
    })
    if (code !== 0) throw new Error('Windows 安装未完成（UAC 被取消或安装失败）')
  } else {
    onProgress({ phase: 'install', pct: 60, msg: '正在安装（系统可能要求输入开机密码）…' })
    const script = `do shell script "installer -pkg ${quoteShell(dest)} -target /" with administrator privileges`
    const code = await new Promise((resolve) => {
      execFile('osascript', ['-e', script], { timeout: 0 }, (err) => resolve(err ? 1 : 0))
    })
    if (code !== 0) throw new Error('macOS 安装未完成（密码被取消或安装失败）')
  }

  onProgress({ phase: 'done', pct: 100, msg: 'Node.js 安装完成' })
  await fsp.rm(dest, { force: true }).catch(() => {})
  return true
}

function quoteWin(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}
