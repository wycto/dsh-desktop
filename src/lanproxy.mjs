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

let server = null
let state = { running: false, listenPort: 0, targetPort: 0, error: '' }

export function proxyState() {
  return { ...state }
}

export function startProxy({ listenPort, targetPort, onLog = () => {} }) {
  stopProxy()
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const preq = http.request(
        {
          host: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
        },
        (pres) => {
          res.writeHead(pres.statusCode || 502, pres.headers)
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
      state = { running: false, listenPort: 0, targetPort: 0, error: err.message }
      onLog(`[壳] 手机访问代理启动失败（端口 ${listenPort}）：${err.message}`)
      resolve({ ok: false, error: err.message })
    })

    s.listen(listenPort, '0.0.0.0', () => {
      server = s
      state = { running: true, listenPort, targetPort, error: '' }
      resolve({ ok: true })
    })
  })
}

export function stopProxy() {
  const s = server
  server = null
  state = { running: false, listenPort: 0, targetPort: 0, error: '' }
  if (s) {
    try { s.closeAllConnections?.() } catch {}
    try { s.close() } catch {}
  }
}
