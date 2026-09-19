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
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

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
export function spawnEnv(nodeDir) {
  const env = { ...process.env }
  if (nodeDir) env.PATH = nodeDir + path.delimiter + (env.PATH || '')
  return env
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
