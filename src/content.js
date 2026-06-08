// Vidulus content script — DOM 上の <video>/<audio>/<source> を走査して報告。
// webRequest で拾えない直接埋め込みメディアやメタデータ（解像度・時間・タイトル）を補う。
(() => {
  'use strict';
  if (window.__vidulusInjected) return;
  window.__vidulusInjected = true;

  const reported = new Set();
  const REPORTED_MAX = 500; // メモリ肥大防止（SPA で際限なく増えないよう上限）

  function markReported(abs) {
    // 上限超過時は最古を1件だけ捨てる（全消し再送を避ける FIFO）
    if (reported.size >= REPORTED_MAX) {
      const oldest = reported.values().next().value;
      reported.delete(oldest);
    }
    reported.add(abs);
  }

  function pageTitle() {
    return (document.querySelector('meta[property="og:title"]')?.content
      || document.title || '').trim();
  }

  function collectFrom(el) {
    const out = [];
    const title = pageTitle();

    const push = (url, extra = {}) => {
      if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
      let abs;
      try { abs = new URL(url, location.href).href; } catch { return; }
      if (reported.has(abs)) return;
      markReported(abs);
      out.push({ url: abs, title, ...extra });
    };

    const scan = (root) => {
      root.querySelectorAll('video, audio').forEach((m) => {
        const kind = m.tagName.toLowerCase() === 'audio' ? 'audio' : 'video';
        const meta = {
          kind,
          width: m.videoWidth || null,
          height: m.videoHeight || null,
          duration: isFinite(m.duration) ? m.duration : null,
          poster: m.poster || null,
        };
        // currentSrc を優先し、異なる場合のみ src も報告（同一動画の二重報告を回避）
        if (m.currentSrc) push(m.currentSrc, meta);
        if (m.src && m.src !== m.currentSrc) push(m.src, meta);
        m.querySelectorAll('source').forEach((s) => {
          if (s.src) push(s.src, { kind: (s.type || '').startsWith('audio') ? 'audio' : kind });
        });
      });
    };

    scan(el);
    return out;
  }

  // 追加ノードに video/audio/source が含まれるかを判定（無関係なDOM変化での再走査を抑制）
  function hasMediaNode(node) {
    if (node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE') return true;
    return typeof node.querySelector === 'function' && !!node.querySelector('video, audio, source');
  }

  function report() {
    const items = collectFrom(document);
    if (items.length) {
      chrome.runtime.sendMessage({ type: 'media-found', items }).catch(() => {});
    }
  }

  // 初回 + DOM 変化を監視（デバウンス）
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(report, 600);
  };

  const obs = new MutationObserver((muts) => {
    for (const mu of muts) {
      // src 属性の差し替え（既存要素のソース変更）も拾う
      if (mu.type === 'attributes') { schedule(); return; }
      for (const n of mu.addedNodes) {
        if (hasMediaNode(n)) { schedule(); return; }
      }
    }
  });

  const start = () => {
    report();
    obs.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['src'],
    });
    // 動画の loadedmetadata で解像度が確定するため再走査
    document.addEventListener('loadedmetadata', schedule, true);
    document.addEventListener('play', schedule, true);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
