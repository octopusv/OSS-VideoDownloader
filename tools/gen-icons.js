#!/usr/bin/env node
/**
 * 依存ゼロの PNG アイコン生成スクリプト。
 * ブランドカラーの角丸スクエア + 「下向き矢印（ダウンロード）」グリフを描画する。
 * 16 / 32 / 48 / 128 px を icons/ に出力。
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ---- 小さな PNG エンコーダ (RGBA, 8bit) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // 各行に filter byte 0 を付与
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 描画ヘルパ ----
function lerp(a, b, t) { return a + (b - a) * t; }
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size;
  const radius = S * 0.235;            // 角丸半径
  // ブランドグラデーション (上: #7C6CF0 → 下: #5A48D6)
  const top = [0x7C, 0x6C, 0xF0];
  const bot = [0x5A, 0x48, 0xD6];

  function px(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const ia = a / 255;
    buf[i]   = Math.round(lerp(buf[i],   r, ia));
    buf[i+1] = Math.round(lerp(buf[i+1], g, ia));
    buf[i+2] = Math.round(lerp(buf[i+2], b, ia));
    buf[i+3] = Math.min(255, buf[i+3] + a);
  }
  // 角丸矩形の内外判定（アンチエイリアス付き）
  function roundedAlpha(x, y) {
    const cx = Math.min(x, S - 1 - x);
    const cy = Math.min(y, S - 1 - y);
    if (cx >= radius || cy >= radius) return 1;     // 直線部
    const dx = radius - cx, dy = radius - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    return Math.max(0, Math.min(1, radius - d + 0.5));
  }

  for (let y = 0; y < S; y++) {
    const t = y / (S - 1);
    const r = Math.round(lerp(top[0], bot[0], t));
    const g = Math.round(lerp(top[1], bot[1], t));
    const b = Math.round(lerp(top[2], bot[2], t));
    for (let x = 0; x < S; x++) {
      const a = roundedAlpha(x, y);
      if (a > 0) px(x, y, r, g, b, Math.round(255 * a));
    }
  }

  // ダウンロードグリフ（白）: 縦バー + 下向き三角 + 受け皿
  const W = [255, 255, 255];
  const cx = S / 2;
  // 縦バー
  const barW = S * 0.11;
  const barTop = S * 0.24;
  const barBot = S * 0.50;
  for (let y = barTop; y < barBot; y++) {
    for (let x = cx - barW / 2; x < cx + barW / 2; x++) {
      px(Math.floor(x), Math.floor(y), ...W, 255);
    }
  }
  // 下向き三角（矢じり）
  const triTop = S * 0.44;
  const triBot = S * 0.66;
  const triHalf = S * 0.20;
  for (let y = triTop; y < triBot; y++) {
    const tt = (y - triTop) / (triBot - triTop);
    const half = triHalf * (1 - tt);
    for (let x = cx - half; x <= cx + half; x++) {
      px(Math.floor(x), Math.floor(y), ...W, 255);
    }
  }
  // 受け皿（トレイ）
  const trayY = S * 0.70;
  const trayH = S * 0.085;
  const trayHalf = S * 0.26;
  const sideW = S * 0.085;
  for (let y = trayY; y < trayY + trayH; y++) { // 底辺
    for (let x = cx - trayHalf; x < cx + trayHalf; x++) px(Math.floor(x), Math.floor(y), ...W, 255);
  }
  for (let y = trayY - S * 0.10; y < trayY + trayH; y++) { // 左右の縦
    for (let x = cx - trayHalf; x < cx - trayHalf + sideW; x++) px(Math.floor(x), Math.floor(y), ...W, 255);
    for (let x = cx + trayHalf - sideW; x < cx + trayHalf; x++) px(Math.floor(x), Math.floor(y), ...W, 255);
  }

  return encodePNG(S, S, buf);
}

for (const size of [16, 32, 48, 128]) {
  const png = draw(size);
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png (${png.length} bytes)`);
}
console.log('done');
