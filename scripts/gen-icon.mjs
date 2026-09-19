/**
 * gen-icon.mjs — 生成应用图标 build/icon.png（1024×1024）
 * 纯 Node 实现：4x 超采样抗锯齿 + 手写 PNG 编码，不依赖任何外部库。
 * 图案：渐变圆角方块 + 白色对话气泡 + 三个输入点（DSH Web 的隐喻）。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const SS = 4 // 超采样倍数
const N = SIZE * SS

// ---- 画布 ----
const img = new Float64Array(N * N * 3) // RGB 线性累加

function put(x, y, r, g, b) {
  const i = (y * N + x) * 3
  img[i] = r; img[i + 1] = g; img[i + 2] = b
}

// 背景：垂直渐变 #5B7CFF → #24349E
const top = [0x5b, 0x7c, 0xff]
const bot = [0x24, 0x34, 0x9e]
for (let y = 0; y < N; y++) {
  const t = y / (N - 1)
  const r = top[0] + (bot[0] - top[0]) * t
  const g = top[1] + (bot[1] - top[1]) * t
  const b = top[2] + (bot[2] - top[2]) * t
  for (let x = 0; x < N; x++) put(x, y, r, g, b)
}

function fillRoundedRect(x0, y0, x1, y1, radius, color) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const hw = (x1 - x0) / 2, hh = (y1 - y0) / 2
  const innerR = radius
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(N, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(N, Math.ceil(x1)); x++) {
      const px = x + 0.5, py = y + 0.5
      const dx = Math.abs(px - cx) - (hw - innerR)
      const dy = Math.abs(py - cy) - (hh - innerR)
      let inside
      if (dx <= 0 || dy <= 0) inside = true
      else inside = dx * dx + dy * dy <= innerR * innerR
      if (inside) put(x, y, color[0], color[1], color[2])
    }
  }
}

function fillCircle(cx, cy, r, color) {
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(N, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(N, Math.ceil(cx + r)); x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy
      if (dx * dx + dy * dy <= r * r) put(x, y, color[0], color[1], color[2])
    }
  }
}

const S = SS
const WHITE = [0xff, 0xff, 0xff]
const DOT = [0x3a, 0x55, 0xd9]

// 背景：画布本身即渐变；按圆角方块裁剪轮廓（把圆角外的四角刷成透明由 macOS/Win 自动处理，
// electron-builder 会生成带透明圆角的系统图标遮罩，这里保留方形渐变底即可）
// 气泡
fillRoundedRect(212 * S, 292 * S, 812 * S, 652 * S, 88 * S, WHITE)
fillCircle(318 * S, 682 * S, 38 * S, WHITE) // 尾巴
// 三个点
for (const cx of [372, 512, 652]) fillCircle(cx * S, 472 * S, 44 * S, DOT)

// ---- 4x 下采样 ----
const out = Buffer.alloc(SIZE * SIZE * 3)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 3
        r += img[i]; g += img[i + 1]; b += img[i + 2]
      }
    }
    const cnt = SS * SS
    const o = (y * SIZE + x) * 3
    out[o] = Math.round(r / cnt)
    out[o + 1] = Math.round(g / cnt)
    out[o + 2] = Math.round(b / cnt)
  }
}

// ---- PNG 编码 ----
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0
  // 兜底实现
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let c = 0xffffffff
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: truecolor
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 3 + 1)] = 0 // filter none
  out.copy(raw, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, png)
console.log(`written ${dest} (${png.length} bytes)`)
