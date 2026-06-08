// Vidulus popup — 検出済みメディアの一覧表示・ダウンロード操作
import { formatBytes, formatDuration, getExt } from '../lib/util.js';

const els = {
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  count: document.getElementById('countLabel'),
  clearBtn: document.getElementById('clearBtn'),
  filterBtn: document.getElementById('filterBtn'),
  filterBar: document.getElementById('filterBar'),
  tpl: document.getElementById('itemTpl'),
  formatSelect: document.getElementById('formatSelect'),
};
const FORMAT_LABEL = { mp4: 'MP4', mkv: 'MKV', m4a: 'M4A', mp3: 'MP3', ts: 'TS' };

let TAB_ID = null;
let items = [];
let filter = 'all';
let activeDownloads = 0;   // 進行中の DL 件数（>0 の間は再描画を抑制）

const KIND_LABEL = { video: 'VIDEO', audio: 'AUDIO', hls: 'HLS', dash: 'DASH', segment: 'SEG' };

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  TAB_ID = tab?.id ?? null;
  bindUI();
  await refresh();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'media-updated' && msg.tabId === TAB_ID) refresh();
    if (msg.type === 'download-progress') onProgress(msg);
  });
}

function bindUI() {
  els.clearBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clear-tab', tabId: TAB_ID });
    items = [];
    render();
    toast('リストをクリアしました');
  });

  els.filterBtn.addEventListener('click', () => {
    els.filterBar.hidden = !els.filterBar.hidden;
  });

  // fixed 配置の画質メニューはスクロールで位置がずれるため、スクロール時は閉じる
  els.list.addEventListener('scroll', closeMenus, { passive: true });

  els.filterBar.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      els.filterBar.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      filter = chip.dataset.filter;
      render();
    });
  });

  // 保存形式設定（既定 mp4）
  chrome.storage.local.get('outFormat').then(({ outFormat = 'mp4' }) => {
    els.formatSelect.value = outFormat;
  });
  els.formatSelect.addEventListener('change', () => {
    const fmt = els.formatSelect.value;
    chrome.storage.local.set({ outFormat: fmt });
    toast(`保存形式: ${FORMAT_LABEL[fmt] || fmt}`);
  });
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: 'get-media', tabId: TAB_ID });
  items = res?.items || [];
  if (activeDownloads > 0) return;   // DL 中はリスト再構築を避ける
  render();
}

function visibleItems() {
  return filter === 'all' ? items : items.filter((i) => i.kind === filter);
}

function render() {
  const vis = visibleItems();
  els.count.textContent = items.length
    ? `${items.length} 件のメディアを検出`
    : '検出待機中';

  els.list.innerHTML = '';
  if (!vis.length) {
    els.empty.hidden = false;
    els.list.style.display = 'none';
    return;
  }
  els.empty.hidden = true;
  els.list.style.display = 'flex';

  for (const item of vis) els.list.appendChild(renderCard(item));
}

function renderCard(item) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  const thumb = node.querySelector('.thumb');
  const badge = node.querySelector('.kind-badge');
  const title = node.querySelector('.title');
  const subline = node.querySelector('.subline');
  const dlBtn = node.querySelector('.dl-btn');
  const moreBtn = node.querySelector('.more-btn');

  badge.textContent = KIND_LABEL[item.kind] || item.kind.toUpperCase();
  badge.className = `kind-badge kind-${item.kind}`;
  // poster は攻撃ページ由来。CSS url() 連結は CSS インジェクションになるため
  // <img> の src に安全な http(s)/data:image URL のみ設定する。
  const posterUrl = safeImageUrl(item.poster);
  if (posterUrl) {
    setThumbImage(thumb, badge, posterUrl, true);
  } else if (item.thumb) {
    setThumbImage(thumb, badge, item.thumb, false);   // 生成済みキャッシュ
  } else if (item.kind === 'hls') {
    requestThumb(item, thumb, badge);                  // 実フレームから生成を要求
  }

  title.textContent = niceName(item);
  title.title = item.url;

  // サブ情報タグ（外部由来文字列は textContent で安全に挿入）
  const tags = [];
  if (item.height) tags.push([`${item.height}p`, true]);
  else if (item.width) tags.push([`${item.width}×?`, false]);
  if (item.duration) tags.push([formatDuration(item.duration), false]);
  if (item.size) tags.push([formatBytes(item.size), false]);
  if (item.variants?.length > 1) tags.push([`${item.variants.length} 画質`, false]);
  else {
    const ext = getExt(item.url);
    if (ext) tags.push([ext.toUpperCase(), false]);
  }
  if (!tags.length) tags.push([hostOf(item.url), false]);
  subline.textContent = '';
  for (const [text, hl] of tags) {
    const span = document.createElement('span');
    span.className = hl ? 'tag hl' : 'tag';
    span.textContent = text;
    subline.appendChild(span);
  }

  dlBtn.addEventListener('click', () => {
    if (node.__downloading) cancelDownload(node);
    else startDownload(item, node, dlBtn);
  });
  moreBtn.addEventListener('click', (e) => openMore(e, item, node));

  return node;
}

async function startDownload(item, node, dlBtn, variant) {
  if (node.__downloading) return;   // 二重起動ガード
  node.__downloading = true;
  const dlId = (crypto.randomUUID ? crypto.randomUUID() : item.id + '_' + Date.now());
  node.__dlId = dlId;          // 進捗イベントとノードを紐付け
  activeDownloads++;
  // 進行中はボタンをキャンセル(×)に切替（HLSのみ実際に中断可能）
  dlBtn.classList.remove('done');
  dlBtn.classList.add('cancel');
  dlBtn.title = 'キャンセル';
  dlBtn.innerHTML = ICON_CANCEL;

  if (item.kind === 'hls') updateProgressUI(node, 0, 1, 0);

  // 画質未指定でマスターなら最高画質を既定にする（ボタン一発で最高画質DL）
  const chosen = variant || (item.variants?.length ? item.variants[0] : null);

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'download',
      tabId: TAB_ID,
      item,
      filename: niceName(item),
      dlId,
      variantUrl: chosen?.url,
      audioUrl: chosen?.audioUrl || null,
      format: els.formatSelect?.value || 'mp4',
    });
    if (res?.ok) {
      markDone(dlBtn, node);
      toast(res.note || 'ダウンロードを開始しました');
    } else {
      throw new Error(res?.error || '不明なエラー');
    }
  } catch (e) {
    node.__downloading = false;
    dlBtn.classList.remove('cancel');
    dlBtn.title = 'ダウンロード';
    dlBtn.innerHTML = ICON_DL;
    hideProgress(node);
    const aborted = /abort/i.test(String(e?.message || e));
    toast(aborted ? 'ダウンロードをキャンセルしました' : 'ダウンロード失敗: ' + (e.message || e), !aborted);
  } finally {
    activeDownloads = Math.max(0, activeDownloads - 1);
    if (activeDownloads === 0) refresh();
  }
}

function cancelDownload(node) {
  if (node.__dlId) {
    chrome.runtime.sendMessage({ type: 'cancel-download', dlId: node.__dlId }).catch(() => {});
  }
}

// HLS: 画質選択メニュー or 補助操作
async function openMore(e, item, node) {
  e.stopPropagation();
  closeMenus();

  const anchor = e.currentTarget; // ⋮ ボタン
  const menu = document.createElement('div');
  menu.className = 'qmenu';

  if (item.kind === 'hls') {
    // 検出時に解析済みの variants があれば再取得不要
    const buildVariants = (variants) => {
      menu.textContent = '';
      for (const v of variants) {
        const b = document.createElement('button');
        const res = document.createElement('span');
        res.className = 'q-res';
        res.textContent = v.label;
        const bw = document.createElement('span');
        bw.className = 'q-bw';
        bw.textContent = v.bandwidth ? Math.round(v.bandwidth / 1000) + 'k' : '';
        b.append(res, bw);
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeMenus();
          const dlBtn = node.querySelector('.dl-btn');
          startDownload(item, node, dlBtn, v); // variant オブジェクトを渡す（audioUrl 含む）
        });
        menu.appendChild(b);
      }
      addMenuItem(menu, 'URL をコピー', () => copyUrl(item.url));
    };

    if (item.variants?.length) {
      buildVariants(item.variants);
      document.body.appendChild(menu);
      positionMenu(menu, anchor);
      setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
      return;
    }

    const loading = document.createElement('button');
    loading.disabled = true;
    loading.style.cssText = 'opacity:.6;cursor:default';
    loading.textContent = '画質を確認中…';
    menu.appendChild(loading);
    document.body.appendChild(menu);
    positionMenu(menu, anchor);
    try {
      const probe = await chrome.runtime.sendMessage({ type: 'probe-hls', url: item.url });
      if (!menu.isConnected) return; // probe 中に閉じられたら何もしない
      menu.textContent = '';
      if (probe?.master && probe.variants?.length) {
        buildVariants(probe.variants); // 内部で「URL をコピー」も付与
      } else {
        addMenuItem(menu, '単一品質をダウンロード', () => {
          closeMenus();
          startDownload(item, node, node.querySelector('.dl-btn'));
        });
        addMenuItem(menu, 'URL をコピー', () => copyUrl(item.url));
      }
    } catch {
      if (!menu.isConnected) return;
      menu.textContent = '';
      addMenuItem(menu, 'URL をコピー', () => copyUrl(item.url));
    }
  } else {
    addMenuItem(menu, 'URL をコピー', () => copyUrl(item.url));
    addMenuItem(menu, '新しいタブで開く', () => {
      if (/^https?:/i.test(item.url)) chrome.tabs.create({ url: item.url });
      else toast('このURLは開けません', true);
    });
    addMenuItem(menu, 'リストから削除', () => removeItem(item));
    document.body.appendChild(menu);
    positionMenu(menu, anchor);
  }

  setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
}

function addMenuItem(menu, label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
  menu.appendChild(b);
}
// アンカー(⋮ボタン)の位置から fixed 配置。下にはみ出す場合は上方向へ反転。
function positionMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight || 160;
  const mw = menu.offsetWidth || 160;
  const vh = window.innerHeight, vw = window.innerWidth;
  let top = r.bottom + 4;
  if (top + mh > vh - 4) top = Math.max(4, r.top - mh - 4); // 下が狭ければ上に開く
  let left = r.right - mw;
  if (left < 4) left = 4;
  if (left + mw > vw - 4) left = vw - mw - 4;
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
}
function closeMenus() {
  document.querySelectorAll('.qmenu').forEach((m) => m.remove());
}

async function removeItem(item) {
  closeMenus();
  await chrome.runtime.sendMessage({ type: 'remove-item', tabId: TAB_ID, id: item.id });
}

async function copyUrl(url) {
  try { await navigator.clipboard.writeText(url); toast('URL をコピーしました'); }
  catch { toast('コピーに失敗しました', true); }
}

// ---- progress ----
function onProgress(msg) {
  const node = [...els.list.children].find((n) => n.__dlId === msg.dlId);
  if (!node) return;
  if (msg.phase === 'convert') {
    showConverting(node, msg.frac);
  } else {
    updateProgressUI(node, msg.done, msg.total, msg.bytes);
  }
}
function showConverting(node, frac) {
  const wrap = node.querySelector('.progress');
  const bar = node.querySelector('.bar span');
  const text = node.querySelector('.progress-text');
  wrap.hidden = false;
  if (typeof frac === 'number' && frac > 0) {
    bar.classList.remove('indeterminate');
    const pct = Math.round(frac * 100);
    bar.style.width = pct + '%';
    text.textContent = `MP4 に変換中… ${pct}%`;
  } else {
    bar.style.width = '100%';
    bar.classList.add('indeterminate');
    text.textContent = 'MP4 に変換中…';
  }
}
function updateProgressUI(node, done, total, bytes) {
  const wrap = node.querySelector('.progress');
  const bar = node.querySelector('.bar span');
  const text = node.querySelector('.progress-text');
  wrap.hidden = false;
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.style.width = pct + '%';
  text.textContent = `${pct}% · ${done}/${total} · ${formatBytes(bytes)}`;
}
function hideProgress(node) {
  const wrap = node.querySelector('.progress');
  if (wrap) wrap.hidden = true;
}
function markDone(dlBtn, node) {
  node.querySelector('.bar span')?.classList.remove('indeterminate');
  hideProgress(node);
  node.__downloading = false;        // 完了後は再ダウンロード可能に
  dlBtn.classList.remove('cancel');
  dlBtn.classList.add('done');
  dlBtn.disabled = false;
  dlBtn.title = 'もう一度ダウンロード';
  dlBtn.innerHTML = ICON_DONE;
}
const ICON_DL = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_CANCEL = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const ICON_DONE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---- thumbnail ----
const thumbRequested = new Set(); // 生成リクエスト中の item.id（多重要求防止）

function setThumbImage(thumb, badge, url, isPoster) {
  if (thumb.querySelector('.thumb-img')) return;
  const img = document.createElement('img');
  img.className = 'thumb-img';
  if (isPoster) { img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; }
  img.src = url;
  img.addEventListener('error', () => img.remove());
  thumb.insertBefore(img, thumb.firstChild);
  badge.style.position = 'absolute';
  badge.style.bottom = '3px';
  badge.style.left = '3px';
}

function requestThumb(item, thumb, badge) {
  if (thumbRequested.has(item.id)) return;
  thumbRequested.add(item.id);
  thumb.classList.add('loading');
  // サムネは高速化のため最低画質バリアントを使う
  const variantUrl = item.variants?.length ? item.variants[item.variants.length - 1].url : undefined;
  chrome.runtime.sendMessage({ type: 'get-thumb', tabId: TAB_ID, id: item.id, url: item.url, variantUrl })
    .then((r) => {
      thumb.classList.remove('loading');
      if (r?.ok && r.thumb) setThumbImage(thumb, badge, r.thumb, false);
    })
    .catch(() => thumb.classList.remove('loading'))
    .finally(() => thumbRequested.delete(item.id));
}

// ---- helpers ----
function niceName(item) {
  if (item.title && item.kind === 'hls') return clean(item.title);
  let base = item.filename || '';
  base = base.replace(/\.[a-z0-9]{1,5}$/i, '');
  if (!base || base.length < 2) base = item.title || hostOf(item.url);
  return clean(base);
}
function clean(s) {
  return (s || '').replace(/[_+]/g, ' ').trim().slice(0, 80) || 'media';
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'media'; }
}
// poster 用に安全な画像URLのみ許可（http/https/data:image）。それ以外は null。
function safeImageUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const url = new URL(u, location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    if (url.protocol === 'data:' && /^data:image\//i.test(u)) return u;
  } catch { /* invalid */ }
  return null;
}

// ---- toast ----
let toastTimer;
function toast(msg, isError = false) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
