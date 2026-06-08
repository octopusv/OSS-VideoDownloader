// 共有ユーティリティ（service worker / module 文脈で利用）

// 拡張子・MIME → メディア種別の判定テーブル
export const MEDIA_EXT = {
  mp4: 'video', m4v: 'video', webm: 'video', mkv: 'video', mov: 'video',
  avi: 'video', flv: 'video', wmv: 'video', mpg: 'video', mpeg: 'video',
  '3gp': 'video', ts: 'video', ogv: 'video',
  mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio',
  opus: 'audio', wav: 'audio', flac: 'audio', weba: 'audio',
  m3u8: 'hls', mpd: 'dash', m4s: 'segment'
};

// 検出対象とする content-type の接頭辞 / 完全一致
export const MEDIA_MIME = [
  'video/', 'audio/',
  'application/vnd.apple.mpegurl', 'application/x-mpegurl',
  'application/dash+xml', 'application/octet-stream-video'
];

// セグメント等、単体ではリスト表示しないノイズ拡張子
export const NOISE_EXT = new Set(['ts', 'm4s']);

export function getExt(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    const m = p.match(/\.([a-z0-9]{1,5})$/);
    return m ? m[1] : '';
  } catch { return ''; }
}

// content-type / 拡張子からメディア種別を推定。非メディアなら null。
export function classify(url, contentType = '') {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  const ext = getExt(url);

  if (ct.includes('mpegurl')) return 'hls';
  if (ct.includes('dash+xml')) return 'dash';
  if (ct.startsWith('video/')) return ext && MEDIA_EXT[ext] === 'segment' ? 'segment' : 'video';
  if (ct.startsWith('audio/')) return 'audio';

  if (ext && MEDIA_EXT[ext]) return MEDIA_EXT[ext];
  return null;
}

export function fileBaseName(url) {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split('/').pop() || '');
    return name || u.hostname;
  } catch { return 'media'; }
}

export function sanitizeFilename(name) {
  return (name || 'download')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 180)
    .trim() || 'download';
}

export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes) || bytes <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// 安定したハッシュ ID（URL 重複排除用）
export function hashId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return 'm' + (h >>> 0).toString(36);
}
