// Vidulus offscreen worker。
// Service Worker では動かない処理（ffmpeg.wasm による TS→MP4 変換・
// URL.createObjectURL・大容量メディアの長時間処理）を担当する非表示 DOM。
import { downloadHls } from './lib/hls.js';
import { transcode, toMp4, FORMATS } from './lib/ffmpeg.js';

// 生成した object URL を dlId 単位で保持（DL 完了後に revoke）
const objectUrls = new Map();
// object URL のセーフティ解放タイマー
const revokeTimers = new Map();
// 進行中ジョブの AbortController（キャンセル用）
const jobControllers = new Map();

function dropObjectUrl(dlId) {
  const url = objectUrls.get(dlId);
  if (url) { URL.revokeObjectURL(url); objectUrls.delete(dlId); }
  const t = revokeTimers.get(dlId);
  if (t) { clearTimeout(t); revokeTimers.delete(dlId); }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.type) {
    case 'offscreen-ping':
      sendResponse?.({ ok: true }); // 起動確認ハンドシェイク
      break;

    case 'offscreen-hls':
      runHlsJob(msg).then(sendResponse).catch((e) => {
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
      return true; // 非同期応答

    case 'offscreen-thumb':
      makeThumb(msg).then(sendResponse).catch((e) => {
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
      return true;

    case 'offscreen-cancel': {
      const c = jobControllers.get(msg.dlId);
      if (c) c.abort();
      sendResponse?.({ ok: true });
      break;
    }

    case 'offscreen-revoke': {
      dropObjectUrl(msg.dlId);
      sendResponse?.({ ok: true });
      break;
    }
  }
});

// サムネイル生成: 先頭セグメントのみ取得→(TSなら)MP4化→video+canvasで1フレーム抽出
async function makeThumb({ url, variantUrl }) {
  const target = variantUrl || url;
  const res = await downloadHls(target, { collect: true, limit: 1 });
  let mp4 = res.blob;
  if (!res.isFmp4) {
    mp4 = await toMp4(res.blob, { inputExt: 'ts' }); // 先頭セグメントを -c copy で MP4 化
  }
  const thumb = await grabFrame(mp4, { maxW: 240 });
  return { ok: true, thumb };
}

// MP4 Blob を <video> に読み込み、1フレームを <canvas> に描画して JPEG dataURL を返す。
// blob URL は拡張オリジン同一なので canvas は汚染されず toDataURL 可能。
function grabFrame(mp4Blob, { maxW = 240 } = {}) {
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(mp4Blob);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    let settled = false;
    const cleanup = () => { URL.revokeObjectURL(objUrl); video.removeAttribute('src'); video.load?.(); };
    const fail = (e) => { if (settled) return; settled = true; cleanup(); reject(e instanceof Error ? e : new Error(String(e))); };
    const watchdog = setTimeout(() => fail(new Error('サムネ生成タイムアウト')), 20000);

    const draw = () => {
      if (settled) return;
      try {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return fail(new Error('動画サイズ取得失敗'));
        const scale = Math.min(1, maxW / vw);
        const cw = Math.max(1, Math.round(vw * scale));
        const ch = Math.max(1, Math.round(vh * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        canvas.getContext('2d').drawImage(video, 0, 0, cw, ch);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        settled = true; clearTimeout(watchdog); cleanup();
        resolve(dataUrl);
      } catch (e) { fail(e); }
    };

    video.addEventListener('error', () => fail(new Error('動画読み込み失敗')), { once: true });
    video.addEventListener('seeked', draw, { once: true });
    video.addEventListener('loadeddata', () => {
      // 意味のあるフレームを狙って少し進める（短尺なら先頭付近）
      const t = Math.min(1, (isFinite(video.duration) ? video.duration : 2) / 3);
      try { video.currentTime = t; } catch { draw(); }
    }, { once: true });
    video.src = objUrl;
  });
}

async function runHlsJob({ dlId, url, variantUrl, audioUrl, format = 'mp4' }) {
  const targetUrl = variantUrl || url;
  const controller = new AbortController();
  jobControllers.set(dlId, controller);
  const signal = controller.signal;
  const progress = (done, total, bytes) =>
    chrome.runtime.sendMessage({ type: 'download-progress', dlId, done, total, bytes, phase: 'download' })
      .catch(() => {});
  const onFrac = (frac) =>
    chrome.runtime.sendMessage({ type: 'download-progress', dlId, phase: 'convert', frac }).catch(() => {});
  const audioOnly = !!FORMATS[format]?.audioOnly;

  try {
    let video = null, audio = null;
    if (audioOnly && audioUrl) {
      // 音声のみ出力 + 分離音声 → 音声プレイリストだけ取得（映像DLを省略）
      audio = await downloadHls(audioUrl, { onProgress: progress, collect: true, signal });
    } else {
      video = await downloadHls(targetUrl, { onProgress: progress, collect: true, signal });
      if (audioUrl) audio = await downloadHls(audioUrl, { collect: true, signal });
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');

    let blob, ext;
    const src = audioOnly ? (audio || video) : video;

    // TS 形式かつ変換不要（TSソース・音声マージ無し）はそのまま渡す
    if (format === 'ts' && !audioUrl && !video?.isFmp4) {
      blob = video.blob; ext = 'ts';
    } else {
      onFrac(0);
      const out = await transcode(src.blob, {
        format,
        inputExt: src.isFmp4 ? 'mp4' : 'ts',
        audioBlob: (!audioOnly && audio) ? audio.blob : null,
        audioExt: audio?.isFmp4 ? 'mp4' : 'ts',
        onProgress: onFrac,
      });
      blob = out.blob; ext = out.ext;
    }

    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const objectUrl = URL.createObjectURL(blob);
    objectUrls.set(dlId, objectUrl);
    // セーフティ: revoke メッセージが届かない場合でも一定時間後に解放しリークを上限化
    revokeTimers.set(dlId, setTimeout(() => dropObjectUrl(dlId), 15 * 60 * 1000));
    return { ok: true, objectUrl, ext, size: blob.size };
  } finally {
    jobControllers.delete(dlId);
  }
}
