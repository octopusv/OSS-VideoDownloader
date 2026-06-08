// ffmpeg.wasm（単スレッド core）ラッパ。
// 出力形式を選択して remux / 音声抽出する。映像系(mp4/mkv/ts)は -c copy で無劣化、
// 音声系(m4a は AAC copy / mp3 は libmp3lame で再エンコード)。
// PTS の不連続・ロールオーバーは ffmpeg が標準で正しく処理する。
// グローバル createFFmpegCore は offscreen.html が classic script で読み込む。

let corePromise = null;

// core を1度だけ生成して使い回す（32MB の wasm を毎回ロードしない）
export function loadFFmpeg() {
  if (corePromise) return corePromise;
  const factory = globalThis.createFFmpegCore;
  if (typeof factory !== 'function') {
    return Promise.reject(new Error('ffmpeg-core.js が読み込まれていません'));
  }
  corePromise = factory({
    locateFile: (p) =>
      p.endsWith('.wasm')
        ? chrome.runtime.getURL('src/vendor/ffmpeg/ffmpeg-core.wasm')
        : p,
  }).catch((e) => { corePromise = null; throw e; });
  return corePromise;
}

// 対応出力形式
export const FORMATS = {
  mp4: { ext: 'mp4', mime: 'video/mp4', audioOnly: false },
  mkv: { ext: 'mkv', mime: 'video/x-matroska', audioOnly: false },
  m4a: { ext: 'm4a', mime: 'audio/mp4', audioOnly: true },
  mp3: { ext: 'mp3', mime: 'audio/mpeg', audioOnly: true },
};

// 単スレッド core の exec は再入不可。全ジョブを直列化する。
let queue = Promise.resolve();
let jobSeq = 0;
function serialize(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

// "HH:MM:SS.ss" → 秒
function parseTime(s) {
  const m = /(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(s);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
}

// blob を指定形式へ変換。複数同時呼び出しは内部キューで直列実行される。
// opts: { format, inputExt, audioBlob, audioExt, onProgress }
// audioBlob を渡すと映像系出力では映像トラックとマージする（分離音声HLS用）。
export function transcode(blob, opts = {}) {
  return serialize(() => _run(blob, opts));
}

// 後方互換ヘルパ
export function toMp4(blob, opts = {}) {
  return transcode(blob, { ...opts, format: 'mp4' });
}

async function _run(blob, opts) {
  const {
    format = 'mp4', inputExt = 'ts', audioBlob = null, audioExt = 'ts', onProgress,
  } = opts;
  const f = FORMATS[format] || FORMATS.mp4;
  const core = await loadFFmpeg();
  const id = ++jobSeq;
  const vName = `in_v_${id}.${inputExt}`;
  const aName = `in_a_${id}.${audioExt}`;
  const outName = `out_${id}.${f.ext}`;

  // ログから Duration / time= を拾って進捗率を算出
  let duration = null;
  if (core.setLogger) {
    core.setLogger((e) => {
      const msg = (e && e.message != null) ? e.message : String(e);
      if (duration == null) {
        const d = /Duration:\s*(\d+:\d{2}:\d{2}\.\d+)/.exec(msg);
        if (d) duration = parseTime(d[1]);
      }
      const t = /time=\s*(\d+:\d{2}:\d{2}\.\d+)/.exec(msg);
      if (t && duration && onProgress) {
        const sec = parseTime(t[1]);
        if (sec != null) onProgress(Math.max(0, Math.min(1, sec / duration)));
      }
    });
  }

  core.FS.writeFile(vName, new Uint8Array(await blob.arrayBuffer()));
  if (audioBlob) core.FS.writeFile(aName, new Uint8Array(await audioBlob.arrayBuffer()));

  try {
    let args;
    if (f.audioOnly) {
      // 音声のみ。blob 自体が音声ソース（offscreen 側で適切な blob を渡す）。
      const codec = format === 'mp3'
        ? ['-c:a', 'libmp3lame', '-q:a', '2']
        : ['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc'];
      args = ['-i', vName, '-vn', ...codec, '-y', outName];
    } else {
      const inputs = ['-i', vName];
      const maps = [];
      if (audioBlob) { inputs.push('-i', aName); maps.push('-map', '0:v:0', '-map', '1:a:0'); }
      const container = format === 'ts' ? ['-f', 'mpegts']
        : format === 'mp4' ? ['-movflags', '+faststart'] : [];
      args = [...inputs, ...maps, '-c', 'copy', ...container, '-y', outName];
    }

    let ret = core.exec(...args);
    if (ret !== 0 && !f.audioOnly) {
      // TS の AAC(ADTS) 等で失敗したらビットストリームフィルタ付きで再試行
      ret = core.exec(...args.slice(0, -1), '-bsf:a', 'aac_adtstoasc', outName);
    }
    if (ret !== 0) throw new Error('ffmpeg 変換に失敗しました (code ' + ret + ')');

    const out = core.FS.readFile(outName);
    if (!out || out.length === 0) throw new Error('変換結果が空です');
    return { blob: new Blob([out], { type: f.mime }), ext: f.ext };
  } finally {
    for (const fn of [vName, aName, outName]) {
      try { core.FS.unlink(fn); } catch { /* noop */ }
    }
    if (core.setLogger) core.setLogger(() => {});
  }
}
