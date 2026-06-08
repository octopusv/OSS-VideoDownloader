# Vidulus — 動画ダウンロード拡張

Web ページ上の **動画・音声・HLS/DASH ストリーム** を自動検出し、ワンクリックで保存できる Chrome 拡張機能です。HLS などの公開仕様と ffmpeg.wasm を用いた**独立実装**で、**Windows / macOS どちらでも同一に動作**します（Chrome 拡張は OS 非依存）。

![icon](icons/icon128.png)

## 主な機能

| 機能 | 説明 |
|------|------|
| 🔍 自動検出 | `webRequest` でネットワークを監視し、動画/音声/HLS(.m3u8)/DASH(.mpd) を検出 |
| 🎬 DOM スキャン | `<video>` `<audio>` `<source>` を走査し、解像度・再生時間・ポスターを取得 |
| 🔢 バッジ表示 | 検出件数をツールバーアイコンにリアルタイム表示 |
| ⬇️ 直接保存 | MP4/WebM/MP3 等は `chrome.downloads` で履歴・レジューム対応のまま保存 |
| 🧩 HLS 結合 | `.m3u8` のセグメント(.ts/.m4s)を取得して 1 ファイルに連結。進捗バー付き |
| 🎞️ 保存形式の選択 | ダウンロード時に **MP4 / MKV / M4A(音声) / MP3(音声) / TS(変換なし)** を選択。映像系は ffmpeg.wasm の `-c copy` で無劣化、M4A も AAC コピー、MP3 は libmp3lame。PTS 不連続/ロールオーバーも正しく処理 |
| 🔐 AES-128 復号 | 暗号化された HLS セグメントを WebCrypto で復号してから結合 |
| 🎚️ 画質選択 | マスタープレイリストから 1080p/720p/… のバリアントを選んでダウンロード |
| 🧷 自動グループ化 | 同一動画の画質別プレイリストをマスター単位で **1カードに統合**。⬇ で最高画質、⋮ で画質選択 |
| 🖼️ 実フレームサムネ | ポスター画像が無い HLS は先頭セグメントから実フレームを抽出してサムネ表示（同一ページの複数動画を判別しやすく） |
| 🖱️ 右クリック保存 | 動画/音声要素のコンテキストメニューから直接追加 |
| 🎨 洗練 UI | ダークテーマ・種別カラーバッジ・フィルタ・トースト通知 |

## インストール（開発者モード読み込み）

両 OS とも手順は同じです。

1. Chrome（または Edge / Brave 等 Chromium 系）で `chrome://extensions` を開く
2. 右上の **「デベロッパー モード」** を ON
3. **「パッケージ化されていない拡張機能を読み込む」** をクリック
4. このフォルダ（`manifest.json` がある階層）を選択

- **macOS**: 例 `/Users/<name>/dev/OSS-VDH`
- **Windows**: 例 `C:\Users\<name>\dev\OSS-VDH`

読み込み後、ツールバーの Vidulus アイコンをクリックすると検出済みメディアの一覧が開きます。

## 使い方

1. 動画のあるページを開く（HLS は **再生を開始**するとストリームが流れ検出されます）
2. アイコンのバッジに件数が表示される
3. アイコンをクリック → 一覧から **⬇ ボタン** で保存
4. HLS は **⋮ メニュー** から画質を選択可能

## 仕組み（アーキテクチャ）

```
manifest.json            … MV3 設定（service worker / content script / 権限）
src/
├─ background.js         … 検出エンジン。webRequest 監視・タブ別管理・DL 制御・offscreen 管理
├─ content.js           … DOM 内のメディア要素を走査して報告
├─ offscreen.html/js     … 非表示 DOM。HLS 取得 + MP4 変換 + Blob URL 生成
├─ lib/
│  ├─ util.js           … 種別判定・整形・ハッシュ等の共有関数
│  ├─ hls.js            … m3u8 パーサ + セグメント取得/AES復号/連結
│  └─ ffmpeg.js         … ffmpeg.wasm ラッパ（TS/fMP4 → MP4 を -c copy で remux）
├─ vendor/ffmpeg/        … ffmpeg.wasm 単スレッド core 同梱（ffmpeg-core.js / .wasm 約32MB）
└─ popup/               … ポップアップ UI（一覧・進捗・画質選択・変換トグル）
tools/gen-icons.js       … 依存ゼロの PNG アイコン生成
```

検出 → `background` がタブ単位で重複排除して保持 → `popup` が取得して描画、という流れです。
HLS は **offscreen document** 内で `fetch` → セグメント連結 →（必要なら ffmpeg.wasm で MP4 変換）→ `URL.createObjectURL` → `background` 経由で `chrome.downloads` に渡します。Service Worker は `window`/WebAssembly 実行に制約があり長時間処理で停止し得るため、重い処理は offscreen 側へ分離しています。

## 制限事項

- **DRM 保護**（Widevine 等）のストリームは復号できません（仕様上不可）。
- **DASH (.mpd)** は現状マニフェストの保存のみ。セグメント結合は今後対応予定。
- MP4 変換は ffmpeg.wasm による `-c copy`（remux）です。HEVC/H.264/AAC など主要コーデックに対応。本体に約32MBの wasm を同梱します。
- `blob:` / `data:` URL の動画は仕様上ネットワーク経由で取得できないため一覧外です。

## 開発

```bash
node tools/gen-icons.js   # アイコン再生成
```

純粋ロジック（`util.js` / `hls.js`）は Node から直接 import してテスト可能です。

## サードパーティ

- **ffmpeg.wasm** (@ffmpeg/core 0.12.10, single-thread) — TS/fMP4 → MP4 remux。`src/vendor/ffmpeg/` に同梱（ffmpeg-core.js / ffmpeg-core.wasm）。ライセンスは `src/vendor/ffmpeg/ffmpeg-core.LICENSE`（FFmpeg / LGPL・GPL）。

## 免責

本プロジェクトは特定の既存製品・企業とは**無関係（非公式）**で、第三者のソースコードは一切使用していない**独立実装**です。各製品名・商標は各権利者に帰属します。

## ライセンス

学習・私的利用目的の参考実装です。ダウンロードは各サイトの利用規約・著作権法を遵守してご利用ください。
