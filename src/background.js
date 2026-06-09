// Vidulus — background service worker（検出エンジン + ダウンロード制御）
import { classify, getExt, fileBaseName, sanitizeFilename, hashId, NOISE_EXT } from './lib/util.js';
import { isMaster, parseMaster } from './lib/hls.js';

// tabId -> Map<id, item>
const tabsMedia = new Map();
// tabId -> { children: Set<variantUrl>, probed: Set<url> }
// children = いずれかのマスターに属する画質別プレイリスト（個別表示しない）
const tabHls = new Map();

const MAX_ITEMS_PER_TAB = 200;

// 進行中の HLS ダウンロードの「真実の状態」。popup を閉じても進捗を保持し、
// 再オープン時・別ページ移動後でも復元できるようにする。 dlId -> 進捗レコード
// { dlId, tabId, itemId, filename, kind, status:'active', phase:'download'|'convert', done, total, bytes, frac }
const downloads = new Map();

function getActiveDownloads(tabId) {
  return [...downloads.values()].filter((d) => d.tabId === tabId && d.status === 'active');
}

// ダウンロード完了/失敗を全コンテキスト（再オープンされた popup を含む）へ通知
function broadcastDownloadDone(dlId, tabId, ok, error) {
  chrome.runtime.sendMessage({ type: 'download-complete', dlId, tabId, ok, error }).catch(() => {});
}

function getTabMap(tabId) {
  if (!tabsMedia.has(tabId)) tabsMedia.set(tabId, new Map());
  return tabsMedia.get(tabId);
}

function getHls(tabId) {
  if (!tabHls.has(tabId)) tabHls.set(tabId, { children: new Set(), probed: new Set() });
  return tabHls.get(tabId);
}

function badge(tabId) {
  const map = tabsMedia.get(tabId);
  const n = map ? map.size : 0;
  const text = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (n > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#5A48D6' }).catch(() => {});
    chrome.action.setBadgeTextColor?.({ tabId, color: '#FFFFFF' }).catch(() => {});
  }
}

function addItem(tabId, item) {
  if (tabId < 0) return;
  // 既知マスターの画質別プレイリストは個別カードにしない（マスターへ統合済み）
  if (item.kind === 'hls' && getHls(tabId).children.has(item.url)) return;

  const map = getTabMap(tabId);
  const id = hashId(item.url);
  const existing = map.get(id);
  if (existing) {
    // 後から判明した情報（サイズ・content-type 等）をマージ
    Object.assign(existing, Object.fromEntries(
      Object.entries(item).filter(([, v]) => v != null && v !== '')
    ));
    notifyPopup(tabId);
    return;
  }
  if (map.size >= MAX_ITEMS_PER_TAB) return;
  item.id = id;
  item.addedAt = Date.now();
  map.set(id, item);
  badge(tabId);
  notifyPopup(tabId);

  // HLS は内容を調べ、マスターなら画質別プレイリストを子として統合
  if (item.kind === 'hls') probeAndGroup(tabId, item);
}

// HLS プレイリストを取得し、マスターなら variants を本体に保持しつつ
// 各画質別プレイリストを children 登録 + 既存の個別カードを除去して1本化する。
async function probeAndGroup(tabId, item) {
  const h = getHls(tabId);
  if (h.probed.has(item.url)) return;
  let text;
  try {
    text = await (await fetchWithTimeout(item.url)).text();
  } catch {
    return; // 失敗時は probed に記録せず、次回検出で再試行可能にする
  }
  h.probed.add(item.url); // 取得成功後にマーク
  if (!isMaster(text)) return; // メディアプレイリスト単体はそのまま
  const variants = parseMaster(text, item.url);
  if (!variants.length) return;

  const map = tabsMedia.get(tabId);
  if (!map) return;
  const cur = map.get(item.id);
  if (cur) {
    cur.isMaster = true;
    cur.variants = variants;
    cur.height = variants[0].height || cur.height; // 最高画質を代表値に
  }
  // 画質別プレイリストを子登録し、先に拾われていた個別カードを削除
  for (const v of variants) {
    h.children.add(v.url);
    const childId = hashId(v.url);
    if (map.has(childId)) map.delete(childId);
  }
  badge(tabId);
  notifyPopup(tabId);
}

function notifyPopup(tabId) {
  chrome.runtime.sendMessage({ type: 'media-updated', tabId }).catch(() => {});
}

// ---------- webRequest による検出 ----------
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const kind = classify(d.url);
    if (!kind) return;
    if (NOISE_EXT.has(getExt(d.url))) return; // 単体セグメントは無視
    addItem(d.tabId, {
      url: d.url,
      kind,
      filename: fileBaseName(d.url),
      source: 'request',
      pageUrl: d.documentUrl || d.initiator || '',
    });
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const headers = d.responseHeaders || [];
    let contentType = '', length = '', disposition = '';
    for (const h of headers) {
      const n = h.name.toLowerCase();
      if (n === 'content-type') contentType = h.value || '';
      else if (n === 'content-length') length = h.value || '';
      else if (n === 'content-disposition') disposition = h.value || '';
    }
    const kind = classify(d.url, contentType);
    if (!kind) return;
    const ext = getExt(d.url);
    if (NOISE_EXT.has(ext) && !contentType.includes('mpegurl')) return;

    let filename = fileBaseName(d.url);
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(disposition);
    if (m) try { filename = decodeURIComponent(m[1]); } catch { filename = m[1]; }

    addItem(d.tabId, {
      url: d.url,
      kind,
      contentType,
      size: length ? parseInt(length, 10) : null,
      filename,
      source: 'response',
      pageUrl: d.documentUrl || d.initiator || '',
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ---------- content script からの報告 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? msg.tabId;

  switch (msg.type) {
    case 'media-found': {
      if (tabId == null) break;
      for (const it of msg.items || []) {
        const kind = it.kind || classify(it.url) || 'video';
        addItem(tabId, {
          url: it.url,
          kind,
          filename: it.filename || fileBaseName(it.url),
          width: it.width || null,
          height: it.height || null,
          duration: it.duration || null,
          poster: it.poster || null,
          title: it.title || null,
          source: 'dom',
          pageUrl: sender.tab?.url || '',
        });
      }
      break;
    }

    case 'get-media': {
      const map = tabsMedia.get(msg.tabId);
      const items = map ? [...map.values()].sort((a, b) => b.addedAt - a.addedAt) : [];
      // 進行中ダウンロードも一緒に返し、popup 再オープン時に進捗を復元できるようにする
      sendResponse({ items, downloads: getActiveDownloads(msg.tabId) });
      return true;
    }

    case 'download-progress': {
      // offscreen からの進捗を「真実の状態」へ反映（popup へは別途直接届く）
      const d = downloads.get(msg.dlId);
      if (d) {
        if (msg.phase === 'convert') {
          d.phase = 'convert';
          d.frac = msg.frac;
        } else {
          d.phase = 'download';
          d.done = msg.done;
          d.total = msg.total;
          d.bytes = msg.bytes;
        }
      }
      break;
    }

    case 'probe-hls': {
      probeHls(msg.url).then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
      return true;
    }

    case 'get-thumb': {
      getThumb(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }

    case 'download': {
      handleDownload(msg, tabId).then(sendResponse).catch((e) => {
        sendResponse({ ok: false, error: String(e.message || e) });
      });
      return true;
    }

    case 'cancel-download': {
      // HLS の取得は offscreen 側で走るためそちらへ転送
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-cancel', dlId: msg.dlId }).catch(() => {});
      sendResponse?.({ ok: true });
      break;
    }

    case 'clear-tab': {
      tabsMedia.delete(msg.tabId);
      tabHls.delete(msg.tabId);
      badge(msg.tabId);
      notifyPopup(msg.tabId);
      sendResponse?.({ ok: true });
      break;
    }

    case 'remove-item': {
      const map = tabsMedia.get(msg.tabId);
      if (map) { map.delete(msg.id); badge(msg.tabId); notifyPopup(msg.tabId); }
      sendResponse?.({ ok: true });
      break;
    }

    case 'set-name': {
      // ユーザーが編集した保存名を item に保持（popup を閉じても残す）。
      // 実ファイル名のサニタイズは保存時 handleDownload で行う。
      const item = tabsMedia.get(msg.tabId)?.get(msg.id);
      if (item) {
        const name = (msg.name || '').trim();
        if (name) item.customName = name;
        else delete item.customName;
      }
      sendResponse?.({ ok: true });
      break;
    }
  }
});

// HLS マスタープレイリストを調べ、画質バリアントを返す（タイムアウト付き）
async function probeHls(url) {
  const res = await fetchWithTimeout(url);
  const text = await res.text();
  if (isMaster(text)) {
    return { master: true, variants: parseMaster(text, url) };
  }
  return { master: false };
}

function fetchWithTimeout(url, ms = 12000) {
  const signal = AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  return fetch(url, { credentials: 'include', signal });
}

// サムネイル取得（先頭セグメントから1フレーム）。結果は item.thumb にキャッシュ。
async function getThumb({ tabId, id, url, variantUrl }) {
  const map = tabsMedia.get(tabId);
  const item = map?.get(id);
  if (item?.thumb) return { ok: true, thumb: item.thumb };

  const token = 'thumb_' + id;
  pendingJobs.add(token); // 生成中は offscreen を閉じない
  try {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-thumb', url, variantUrl });
    if (r?.ok && r.thumb) {
      const cur = tabsMedia.get(tabId)?.get(id);
      if (cur) cur.thumb = r.thumb; // アイテムにキャッシュ（再オープンで再生成しない）
    }
    return r || { ok: false, error: 'no response' };
  } finally {
    pendingJobs.delete(token);
    maybeCloseOffscreen();
  }
}

// ---------- ダウンロード処理 ----------
async function handleDownload(msg, tabId) {
  const { item, filename } = msg;
  const safe = sanitizeFilename(filename || item.filename || 'video');

  // 通常ファイル: chrome.downloads に委譲（レジューム・履歴対応）
  if (item.kind === 'video' || item.kind === 'audio') {
    const ext = getExt(item.url) || (item.kind === 'audio' ? 'mp3' : 'mp4');
    const name = /\.[a-z0-9]{1,5}$/i.test(safe) ? safe : `${safe}.${ext}`;
    const id = await chrome.downloads.download({ url: item.url, filename: name });
    return { ok: true, downloadId: id, mode: 'direct' };
  }

  // HLS: offscreen document でセグメント結合 + 選択形式へ変換
  if (item.kind === 'hls') {
    const dlId = msg.dlId || (crypto.randomUUID ? crypto.randomUUID() : hashId(item.url + Date.now()));
    const format = msg.format || await getFormatSetting();
    pendingJobs.add(dlId);
    // 進捗レコードを登録（早期に登録し、取得開始直後の再オープンでも復元可能にする）
    // filename/kind も保持し、別ページへ移動して元アイテムが消えても単独カードで表示できるようにする
    downloads.set(dlId, {
      dlId, tabId, itemId: item.id, status: 'active',
      filename: filename || item.filename || 'video', kind: item.kind,
      phase: 'download', done: 0, total: 1, bytes: 0, frac: 0,
    });
    let revoked = false;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-revoke', dlId }).catch(() => {});
    };
    try {
      await ensureOffscreen();
      const result = await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'offscreen-hls',
        dlId, url: item.url, variantUrl: msg.variantUrl, audioUrl: msg.audioUrl, format,
      });
      if (!result?.ok) throw new Error(result?.error || 'HLS の取得に失敗しました');

      const name = ensureExt(safe, result.ext);
      let downloadId;
      try {
        downloadId = await chrome.downloads.download({ url: result.objectUrl, filename: name });
      } catch (e) {
        revoke(); // download 起動失敗時も object URL を解放
        throw e;
      }

      // ダウンロード完了/失敗後に offscreen 側の object URL を解放
      waitDownloadDone(downloadId).finally(() => {
        revoke();
        pendingJobs.delete(dlId);
        maybeCloseOffscreen();
      });
      // セグメント取得・変換は完了し、あとはブラウザがディスクへ書き出すだけ。
      // 進捗を完了扱いにして、再オープンされた popup にも通知する。
      downloads.delete(dlId);
      broadcastDownloadDone(dlId, tabId, true);
      return { ok: true, downloadId, mode: 'hls-' + result.ext };
    } catch (e) {
      revoke();
      pendingJobs.delete(dlId);
      maybeCloseOffscreen();
      downloads.delete(dlId);
      broadcastDownloadDone(dlId, tabId, false, String(e?.message || e));
      throw e;
    }
  }

  // DASH 等は将来対応。まずは manifest を保存。
  if (item.kind === 'dash') {
    const id = await chrome.downloads.download({ url: item.url, filename: `${safe}.mpd` });
    return { ok: true, downloadId: id, mode: 'manifest', note: 'DASH は現状マニフェストのみ保存します' };
  }

  throw new Error('未対応のメディア種別: ' + item.kind);
}

// ファイル名に拡張子を保証
function ensureExt(name, ext) {
  return /\.[a-z0-9]{1,5}$/i.test(name) ? name : `${name}.${ext}`;
}

// 出力形式設定（既定 mp4）。mp4/mkv/m4a/mp3/ts
async function getFormatSetting() {
  const { outFormat = 'mp4' } = await chrome.storage.local.get('outFormat');
  return outFormat;
}

// ---------- offscreen document 管理 ----------
const pendingJobs = new Set();   // 進行中の HLS ジョブ dlId
let offscreenOp = Promise.resolve(); // 生成/破棄を直列化（TOCTOU 回避）

// 生成/破棄を直列化するためのロック
function withOffscreenLock(fn) {
  const p = offscreenOp.then(fn, fn);
  offscreenOp = p.catch(() => {});
  return p;
}

async function ensureOffscreen() {
  await withOffscreenLock(async () => {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen.html',
        reasons: ['BLOBS'],
        justification: 'HLS セグメントの結合・MP4 変換とダウンロード用 Blob URL の生成',
      });
    }
  });
  // offscreen.js(module) と ffmpeg-core.js の評価＝リスナー登録完了を ping で待つ
  await waitOffscreenReady();
}

async function waitOffscreenReady(retries = 120) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-ping' });
      if (r?.ok) return; // ping 応答時点で createFFmpegCore も定義済み（classic script は module 前に評価）
    } catch { /* まだリスナー未登録 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('offscreen document の起動に失敗しました');
}

async function maybeCloseOffscreen() {
  await withOffscreenLock(async () => {
    if (pendingJobs.size > 0) return; // ロック下で再確認（進行中なら閉じない）
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  });
}

// 指定ダウンロードの完了/中断を待つ
function waitDownloadDone(id) {
  return new Promise((resolve) => {
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      const s = delta.state.current;
      if (s === 'complete' || s === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(s);
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

// ---------- ライフサイクル ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  tabsMedia.delete(tabId);
  tabHls.delete(tabId);
  for (const [dlId, d] of downloads) if (d.tabId === tabId) downloads.delete(dlId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // ページ遷移で検出をリセット
  if (info.status === 'loading' && info.url) {
    tabsMedia.delete(tabId);
    tabHls.delete(tabId);
    badge(tabId);
    notifyPopup(tabId);
  }
});

// 右クリックメニュー（メディア要素から直接保存）
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'vidulus-save',
    title: 'Vidulus でこのメディアを保存',
    contexts: ['video', 'audio'],
  }, () => chrome.runtime.lastError);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'vidulus-save') return;
  const url = info.srcUrl;
  if (!url || url.startsWith('blob:')) return;
  addItem(tab.id, {
    url,
    kind: classify(url) || 'video',
    filename: fileBaseName(url),
    source: 'contextmenu',
    pageUrl: tab.url,
  });
});
