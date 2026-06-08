// HLS (.m3u8) のパースとセグメント結合ダウンロード。
// マスタープレイリストから画質バリアント・分離音声トラックを抽出し、
// メディアプレイリストの .ts / .m4s セグメントを取得して連結する。
// AES-128 暗号化・#EXT-X-BYTERANGE・分離音声(#EXT-X-MEDIA)に対応。

function resolveUrl(base, ref) {
  try { return new URL(ref, base).href; } catch { return ref; }
}

function parseAttrs(line) {
  // KEY=VALUE,KEY="VALUE" 形式を分解（引用符内のカンマは保持）
  const attrs = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return attrs;
}

// 拡張機能は host_permissions により CORS をバイパスでき、credentials:'include' で
// Cookie 認証コンテンツも取得できる。万一 include で失敗した場合は omit で再試行。
async function rawFetch(url, { signal, headers } = {}) {
  try {
    return await fetch(url, { credentials: 'include', signal, headers });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return await fetch(url, { credentials: 'omit', signal, headers });
  }
}

async function fetchText(url, signal) {
  const res = await rawFetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} : ${url}`);
  return res.text();
}

async function fetchBuf(url, { signal, byteRange } = {}) {
  const headers = {};
  if (byteRange) headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
  const res = await rawFetch(url, { signal, headers });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} : ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

// マスタープレイリストか否か
export function isMaster(text) {
  return /#EXT-X-STREAM-INF/.test(text);
}

// マスター → バリアント配列（各バリアントに分離音声 audioUrl を付与可）
export function parseMaster(text, baseUrl) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const variants = [];
  const audioGroups = {}; // groupId -> [{ uri, default }]

  // 先に #EXT-X-MEDIA(TYPE=AUDIO) を収集
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE === 'AUDIO' && a['GROUP-ID']) {
        (audioGroups[a['GROUP-ID']] ||= []).push({
          uri: a.URI ? resolveUrl(baseUrl, a.URI) : null,
          default: a.DEFAULT === 'YES',
        });
      }
    }
  }
  const pickAudio = (groupId) => {
    const list = audioGroups[groupId];
    if (!list || !list.length) return null;
    const chosen = list.find((x) => x.default && x.uri) || list.find((x) => x.uri);
    return chosen ? chosen.uri : null; // URI 無し（映像に多重化済み）なら null
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const nxt = lines[j].trim();
        if (nxt && !nxt.startsWith('#')) { uri = nxt; i = j; break; }
      }
      if (!uri) continue;
      const res = a.RESOLUTION || '';
      const height = res ? parseInt(res.split('x')[1], 10) : 0;
      variants.push({
        url: resolveUrl(baseUrl, uri),
        bandwidth: parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10),
        resolution: res,
        height,
        codecs: a.CODECS || '',
        audioUrl: a.AUDIO ? pickAudio(a.AUDIO) : null,
        label: res ? `${height}p` : (a.BANDWIDTH ? `${Math.round(a.BANDWIDTH / 1000)}kbps` : 'auto'),
      });
    }
  }
  variants.sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
  return variants;
}

// メディアプレイリスト → セグメント情報（BYTERANGE 対応）
export function parseMedia(text, baseUrl) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const segments = [];
  let duration = 0;
  let key = null;            // { method, uri, iv }
  let map = null;            // { url, byteRange } fMP4 初期化セグメント
  let seq = 0;
  let pendingRange = null;   // 直前の #EXT-X-BYTERANGE
  const rangeCursor = {};    // url -> 次の連続オフセット

  const rangeFor = (url) => {
    if (!pendingRange) return null;
    let offset = pendingRange.offset;
    if (offset == null) offset = rangeCursor[url] || 0;
    const br = { offset, length: pendingRange.length };
    rangeCursor[url] = offset + pendingRange.length;
    pendingRange = null;
    return br;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = parseInt(line.split(':')[1], 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice('#EXT-X-KEY:'.length));
      key = a.METHOD === 'NONE' ? null : {
        method: a.METHOD,
        uri: a.URI ? resolveUrl(baseUrl, a.URI) : null,
        iv: a.IV || null,
      };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice('#EXT-X-MAP:'.length));
      if (a.URI) {
        let br = null;
        if (a.BYTERANGE) {
          const [len, off] = a.BYTERANGE.split('@');
          br = { offset: off != null ? parseInt(off, 10) : 0, length: parseInt(len, 10) };
        }
        map = { url: resolveUrl(baseUrl, a.URI), byteRange: br };
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const v = line.slice('#EXT-X-BYTERANGE:'.length).trim();
      const [len, off] = v.split('@');
      pendingRange = { length: parseInt(len, 10), offset: off != null ? parseInt(off, 10) : null };
    } else if (line.startsWith('#EXTINF:')) {
      const d = parseFloat(line.slice('#EXTINF:'.length)) || 0;
      for (let j = i + 1; j < lines.length; j++) {
        const nxt = lines[j].trim();
        if (nxt && !nxt.startsWith('#')) {
          const url = resolveUrl(baseUrl, nxt);
          segments.push({
            url,
            duration: d,
            key,
            seq: seq + segments.length,
            byteRange: rangeFor(url),
          });
          duration += d;
          i = j;
          break;
        }
      }
    }
  }
  return { segments, duration, map };
}

// IV 文字列(0x...) → Uint8Array(16)。未指定時はシーケンス番号(128bit big-endian)から生成。
function ivFromString(ivStr, seq) {
  const iv = new Uint8Array(16);
  if (ivStr) {
    const hex = ivStr.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    // デフォルト IV = メディアシーケンス番号（下位64bitを big-endian で配置）
    new DataView(iv.buffer).setBigUint64(8, BigInt(Math.max(0, Math.floor(seq))));
  }
  return iv;
}

// セグメントを順次取得。onProgress(done, total, bytes) で進捗通知。
// 暗号化(AES-128)時は WebCrypto で復号。
// opts.onSegment(bytes, { index, isInit }) があれば各セグメントを逐次コールバック。
// opts.collect が false の場合は連結 Blob を作らず返り値の blob は null（メモリ節約）。
export async function downloadHls(mediaUrl, opts = {}) {
  const { onProgress, signal, onSegment, collect = true, limit = Infinity } = opts;
  let text = await fetchText(mediaUrl, signal);

  // マスタープレイリストを渡された場合は最高画質のメディアプレイリストへ自動解決
  if (isMaster(text)) {
    const variants = parseMaster(text, mediaUrl);
    if (!variants.length) throw new Error('画質バリアントが見つかりませんでした');
    mediaUrl = variants[0].url; // parseMaster は解像度降順ソート済み
    text = await fetchText(mediaUrl, signal);
  }

  const { segments, map } = parseMedia(text, mediaUrl);
  if (!segments.length) throw new Error('セグメントが見つかりませんでした');

  const keyCache = new Map();
  async function getKey(uri) {
    if (!keyCache.has(uri)) {
      const raw = await fetchBuf(uri, { signal });
      keyCache.set(uri, await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
    }
    return keyCache.get(uri);
  }

  const parts = collect ? [] : null;
  let bytes = 0;
  const total = Math.min(segments.length, limit); // limit でサムネ用に先頭のみ取得可
  const isFmp4 = !!map;

  if (map) {
    const init = await fetchBuf(map.url, { signal, byteRange: map.byteRange });
    if (collect) parts.push(init);
    onSegment?.(init, { index: -1, isInit: true });
    bytes += init.length;
  }

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const seg = segments[i];
    let data = await fetchBuf(seg.url, { signal, byteRange: seg.byteRange });
    if (seg.key && seg.key.method === 'AES-128' && seg.key.uri) {
      const ck = await getKey(seg.key.uri);
      const iv = ivFromString(seg.key.iv, seg.seq);
      const dec = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, data);
      data = new Uint8Array(dec);
    }
    if (collect) parts.push(data);
    onSegment?.(data, { index: i, isInit: false });
    bytes += data.length;
    onProgress?.(i + 1, total, bytes);
  }

  return {
    blob: collect ? new Blob(parts, { type: isFmp4 ? 'video/mp4' : 'video/mp2t' }) : null,
    ext: isFmp4 ? 'mp4' : 'ts',
    isFmp4,
    bytes,
  };
}
