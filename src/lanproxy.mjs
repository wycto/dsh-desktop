/**
 * lanproxy.mjs — 手机/局域网访问反向代理
 *
 * dsh web 出于安全只绑定 127.0.0.1，手机和其他设备无法直接访问。
 * 本模块在壳内启动一个轻量 HTTP 反向代理，监听 0.0.0.0 上的指定端口，
 * 把请求原样转发给本机的 dsh 服务；WebSocket 升级请求按原始 TCP 隧道
 * 双向透传（SSE / 流式响应经普通管道转发，不做缓冲）。
 * 访问凭据沿用 dsh 自身的 token，本模块不做额外鉴权。
 */
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

let server = null
let state = { running: false, listenPort: 0, targetPort: 0, error: '' }

// ---- dsh 会话 Cookie 双向改写（治本思路见下）----
// dsh 的会话 Cookie 按「请求 Host」签名与校验（authority 绑定）：Cookie 名是
// Host 的 SHA-256 哈希，值里的 authority 字段也必须是当前 Host。本代理把上游
// Host 固定改写为 127.0.0.1:<targetPort>，导致 token 兑换签出的 Cookie 绑定
// 回环地址；手机浏览器以局域网 IP 访问时 Cookie 名对不上、干脆不带，回到 401。
// 修法（不改 dsh、不碰密钥）：
//  - 下行（响应）：token 兑换成功时把 Cookie 名改写为按「手机实际 Host」计算
//    的哈希，浏览器按这个名字存；值（回环地址签名）原样保留。
//  - 上行（请求）：转发前把 Cookie 名改回按「127.0.0.1:<targetPort>」计算的
//    哈希——代理同时把 Host 也改写成回环，上游 dsh 按回环 Host 查找 Cookie
//    时名字与签发 authority 都对得上，鉴权闭环。
function cookieNameFor(host) {
  return 'dsh-auth-' + crypto.createHash('sha256').update(String(host)).digest('base64url')
}
/** 把 Cookie 头里所有 dsh-auth-* 的名字换成 newName（值不动）。 */
function renameDshCookies(cookieHeader, newName) {
  if (!cookieHeader) return cookieHeader
  return String(cookieHeader).replace(/dsh-auth-[A-Za-z0-9_-]+=/g, `${newName}=`)
}

export function proxyState() {
  return { ...state }
}

export function startProxy({ listenIp = '0.0.0.0', listenPort, targetPort, onLog = () => {} }) {
  stopProxy()
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const upstreamHost = `127.0.0.1:${targetPort}`
      const reqHeaders = { ...req.headers, host: upstreamHost }
      // 上行：把手机 Host 的 Cookie 名换回上游（回环）Host 的名字，
      // 与 host 改写配套，让 dsh 按回环 authority 查找时能命中。
      if (req.headers.cookie) reqHeaders.cookie = renameDshCookies(req.headers.cookie, cookieNameFor(upstreamHost))
      const preq = http.request(
        { host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: reqHeaders },
        (pres) => {
          // 下行：token 兑换签出的 Cookie 名绑定回环 Host，手机浏览器不会
          // 为局域网 IP 发送它。改写为按手机实际 Host 计算的名字，浏览器
          // 存下后后续请求会带上（上行时再改回去，见上）。
          const headers = { ...pres.headers }
          const setCookie = headers['set-cookie']
          if (Array.isArray(setCookie) && setCookie.length > 0 && req.headers.host) {
            const name = cookieNameFor(req.headers.host)
            headers['set-cookie'] = setCookie.map((line) =>
              String(line).replace(/^dsh-auth-[A-Za-z0-9_-]+=/, `${name}=`))
          }
          res.writeHead(pres.statusCode || 502, headers)
          pres.pipe(res)
        },
      )
      preq.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        try { res.end('无法连接到本机的 dsh 服务（可能已停止），请在电脑端重新启动服务。') } catch {}
      })
      req.pipe(preq)
    })

    // WebSocket 升级：按原始字节重建请求头后建立 TCP 隧道
    s.on('upgrade', (req, socket, head) => {
      const up = net.connect(targetPort, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        }
        up.write(lines.join('\r\n') + '\r\n\r\n')
        if (head?.length) up.write(head)
        socket.pipe(up)
        up.pipe(socket)
      })
      const fail = () => {
        try { socket.destroy() } catch {}
        try { up.destroy() } catch {}
      }
      up.on('error', fail)
      socket.on('error', fail)
    })

    s.on('error', (err) => {
      state = { running: false, listenIp: '', listenPort: 0, targetPort: 0, error: err.message }
      onLog(`[壳] 手机访问代理启动失败（${listenIp}:${listenPort}）：${err.message}`)
      resolve({ ok: false, error: err.message })
    })

    s.listen(listenPort, listenIp, () => {
      server = s
      state = { running: true, listenIp, listenPort, targetPort, error: '' }
      resolve({ ok: true })
    })
  })
}

export function stopProxy() {
  const s = server
  server = null
  state = { running: false, listenIp: '', listenPort: 0, targetPort: 0, error: '' }
  if (s) {
    try { s.closeAllConnections?.() } catch {}
    try { s.close() } catch {}
  }
}
