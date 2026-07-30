/**
 * 端到端驗證:用瀏覽器的假麥克風播放一段真人台語音檔,走完整條路
 * (Web Audio 收音 → VAD 切段 → 包 WAV → POST /transcribe → 真模型辨識 → 畫面出字幕),
 * 然後斷言畫面上真的出現中文字幕。
 *
 * 這不是單元測試,它會真的載入模型、真的辨識,所以需要後端已經在跑。
 *
 * 用法:
 *   scripts/run.sh                                  # 另一個終端先把後端跑起來
 *   NODE_PATH=$(npm root -g) node scripts/e2e-check.mjs [url] [wav]
 *
 * 預設 url = http://127.0.0.1:8000,預設 wav = testdata 裡的行政院台語廣播。
 * 音檔必須是 16-bit PCM WAV,Chrome 的假麥克風只吃這種。
 *
 * 實測踩到的四個環境限制,寫在這裡免得下一個人重踩(細節見 VERIFICATION.md 五之二):
 * 1. 一定要用真 Chrome 且有頭模式。headless chromium 連 getUserMedia({audio:true}) 都會回
 *    NotSupportedError(安全環境、mediaDevices、裝置列舉全正常,就是沒有音訊擷取)。
 *    所以這支測試需要有 X display。
 * 2. 假麥克風有機率完全沒餵進音訊(多個 Chrome 交替啟動搶音訊裝置時特別容易)。
 *    這是測試環境的問題不是 app 的問題,所以下面會先確認音訊真的進來,沒進來就重開瀏覽器重試。
 * 3. 不能用 page.waitForFunction 等條件,會被 index.html 的 CSP 擋掉。改成自己輪詢 page.evaluate。
 * 4. 自簽憑證下 service worker 註冊一定失敗,那是憑證的限制,歸到 notes 不算測試失敗。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 createRequire 而不是 import:這樣 playwright 裝在專案裡或裝在全域
// (搭配 NODE_PATH=$(npm root -g))都找得到,ESM 的 import 不吃 NODE_PATH。
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('找不到 playwright。裝法:npm i -D playwright && npx playwright install chromium');
  console.error('或用全域安裝:NODE_PATH=$(npm root -g) node scripts/e2e-check.mjs');
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const url = process.argv[2] || 'http://127.0.0.1:8000';
const wav = resolve(process.argv[3] || `${ROOT}/testdata/web-ey-psa-115-03-edu-taigi-ime-taigi.wav`);
const shot = `${ROOT}/e2e-shot.png`;
const CAPTION_MS = 60000; // 硬上限切段是 12 秒,配樂型音源停頓少,要給足時間
const AUDIO_MS = 12000; // 音訊有沒有進來,幾秒內就看得出
const TRIES = 3;

if (!existsSync(wav)) {
  console.error(`找不到音檔:${wav}`);
  console.error('testdata/ 不隨 repo 散布,請自己放一段 16kHz 單聲道 16-bit 的台語 WAV 進去,或用參數指定。');
  process.exit(2);
}

const state = (page) =>
  page
    .evaluate(() => {
      const t = window.__taigi;
      return {
        狀態: document.querySelector('#status')?.innerText,
        噪音底線: t && +t.vad.floor.toFixed(5),
        有偵測到語音: t && t.vad.on,
        暖機frame: t && t.vad.warm.length,
        累積frame: t && t.vad.frames.length,
        在途請求: t && t.inflight,
        畫面文字: (document.querySelector('#stage')?.innerText || '').slice(0, 120),
      };
    })
    .catch((e) => ({ 探測失敗: String(e) }));

async function attempt(n) {
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chrome',
    headless: process.env.E2E_HEADLESS === '1',
    args: [
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--use-fake-ui-for-media-stream',
    ],
  });
  // ignoreHTTPSErrors 是為了 scripts/make-cert.sh 產的自簽憑證:
  // 使用者實際就是跑 HTTPS(手機要麥克風權限),測試也應該能打那個位址。
  const ctx = await browser.newContext({ permissions: ['microphone'], ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  // 自簽憑證下 service worker 一定註冊不起來(Chrome 不讓有憑證錯誤的來源註冊 SW),
  // 那是憑證的限制不是 app 的錯,所以歸到 notes 不算失敗。其餘主控台錯誤一律算失敗。
  const errors = [];
  const notes = [];
  const known = (t) => /SSL certificate error occurred when fetching the script/i.test(t);
  const record = (t) => (known(t) ? notes : errors).push(t);
  page.on('console', (m) => { if (m.type() === 'error') record(m.text()); });
  page.on('pageerror', (e) => record(String(e)));

  try {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    } catch (e) {
      return { verdict: 'goto', err: String(e.message || e).split('\n')[0] };
    }
    const health = await page
      .evaluate(async () => (await fetch('/health', { cache: 'no-store' })).json())
      .catch((e) => ({ error: String(e) }));
    if (n === 1) console.log(`後端 /health:${JSON.stringify(health)}`);
    if (!health.ok) return { verdict: 'backend', health };

    // 不要在這裡先預熱麥克風。實測兩條擷取串流同時存在時,Chrome 的假檔案音源只會餵其中一條,
    // 預熱反而讓 app 自己那條收不到任何 frame(畫面停在「聆聽中」但 frame 數是 0)。
    // Chrome 偶爾會在第一次取得裝置時卡住,那個情況交給下面的重試,app 端也有 15 秒逾時保護。
    //
    // 按下後要確認真的啟動了才往下走。自動化環境下第一次點擊有機率完全沒生效
    // (狀態一直停在「待機」,像是點擊被吞掉),原因還沒查清楚,所以這裡最多按三次。
    for (let k = 0; k < 3; k++) {
      await page.click('#toggle');
      const started = await page
        .waitForSelector('#toggle[data-on="1"]', { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      if (started) break;
      if (process.env.E2E_DEBUG) console.log(`    第 ${k + 1} 次點擊沒有生效,再按一次`);
    }

    // 先確認假麥克風真的餵進音訊了,不然接下來的等待毫無意義
    let gotAudio = false;
    for (let i = 0; i < AUDIO_MS / 1000; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await state(page);
      if (process.env.E2E_DEBUG) console.log(`    t+${i + 1}s ${JSON.stringify(s)}`);
      if (s.暖機frame > 0) { gotAudio = true; break; }
    }
    if (!gotAudio) return { verdict: 'noaudio', diag: await state(page) };

    // 等真的字幕。這裡刻意不用 page.waitForFunction:它會在頁面裡以字串求值,
    // 而本專案的 index.html 有 CSP(script-src 'self' blob:,不允許 unsafe-eval),
    // 會被擋掉並丟 EvalError,等待就永遠不會成立。CSP 是刻意的,所以改成自己輪詢 page.evaluate。
    //
    // 一定要挑 .line 節點,不能讀整個 #stage 的文字:開場提示本身就含中文,
    // 讀 innerText 會在還沒有任何字幕時就誤判通過。也要排掉 .pending 占位節點與 .bad 錯誤訊息。
    const readCaption = () =>
      page
        .evaluate(() =>
          [...document.querySelectorAll('#stage .line:not(.pending):not(.bad)')]
            .map((el) => el.innerText.trim())
            .filter((t) => /[一-鿿]{4,}/.test(t))
            .join('\n'),
        )
        .catch(() => '');

    let caption = '';
    for (let i = 0; i < CAPTION_MS / 1000 && !caption; i++) {
      caption = await readCaption();
      if (!caption) await new Promise((r) => setTimeout(r, 1000));
      if (process.env.E2E_DEBUG && i % 5 === 0) console.log(`    等字幕 t+${i}s ${JSON.stringify(await state(page))}`);
    }

    const diag = await state(page);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    if (!caption) return { verdict: 'nocaption', diag, errors, notes };
    return { verdict: 'ok', caption, errors, notes };
  } finally {
    await browser.close().catch(() => {});
  }
}

let result;
for (let n = 1; n <= TRIES; n++) {
  console.log(n === 1 ? `開頁 ${url},對著假麥克風播放真人台語音檔` : `第 ${n} 次嘗試(上一次假麥克風沒餵進音訊)`);
  result = await attempt(n);
  if (result.verdict !== 'noaudio') break;
}

if (result.verdict === 'ok') {
  console.log('畫面上的字幕:');
  result.caption.split('\n').filter(Boolean).forEach((l) => console.log(`    ${l}`));
  const chars = (result.caption.match(/[一-鿿]/g) || []).length;
  if (chars < 8) {
    console.error(`  不通過:字幕只有 ${chars} 個中文字,太少`);
    process.exit(1);
  }
  if (result.notes?.length) {
    console.log(`  註:${result.notes.length} 個已知且可接受的主控台訊息(自簽憑證下 service worker 不會註冊,`);
    console.log('      所以用自簽憑證時沒有 PWA 離線外殼,要真憑證才有)。');
  }
  if (result.errors.length) {
    console.error(`  不通過:主控台有 ${result.errors.length} 個錯誤:${result.errors.slice(0, 3).join(' | ')}`);
    process.exit(1);
  }
  console.log(`截圖 ${shot}`);
  console.log('\n端到端驗證通過:真人台語音檔進去,畫面出中文字幕');
  process.exit(0);
}

if (result.verdict === 'goto') {
  console.error(`  不通過:開不了頁面。${result.err}`);
  console.error(`  確認 ${url} 真的有服務在跑(scripts/run.sh),位址與埠號沒打錯。`);
} else if (result.verdict === 'backend') {
  console.error(`  不通過:後端沒有回報 ok。先確認 scripts/run.sh 起來了、模型載入完成。${JSON.stringify(result.health)}`);
} else if (result.verdict === 'noaudio') {
  console.error(`  試了 ${TRIES} 次,瀏覽器都沒有收到假麥克風的音訊(暖機 frame 是 0)。`);
  console.error('  這是測試環境的問題不是 app 的問題:先關掉其他佔用音訊裝置的 Chrome,確認 DISPLAY 可用,再重跑。');
  console.error(`  診斷:${JSON.stringify(result.diag, null, 1)}`);
} else {
  console.error(`  不通過:音訊有進來,但等了 ${CAPTION_MS / 1000} 秒畫面還是沒有字幕。這是真的失敗,要查 app。`);
  console.error(`  診斷:${JSON.stringify(result.diag, null, 1)}`);
  if (result.errors?.length) console.error(`  主控台錯誤:${result.errors.slice(0, 3).join(' | ')}`);
}
process.exit(1);
