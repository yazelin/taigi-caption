'use strict';
/*
 * 台語即時字幕:前端。台語語音進 → 後端回繁體中文字 → 大字即時顯示。
 *
 * 音訊路徑刻意不用 MediaRecorder 的 timeslice 分段:只有第一個 chunk 帶 WebM 容器標頭,
 * 之後的 chunk 單獨送到後端解不開。這裡走 Web Audio 拿原始 Float32 PCM,
 * 自己線性重取樣到 16000Hz,自己包成 16-bit PCM WAV,後端不需要 ffmpeg。
 *
 * 自我檢查(可在瀏覽器 console 重跑,不需要麥克風也不需要測試框架):
 * 步驟與預期輸出寫在 selfcheck.md,入口是 window.__taigi。
 */

const RATE = 16000;          // 送給後端的取樣率
const FRAME = 320;           // 20ms 一個 VAD frame
const WARM = 25;             // 開始收音後先量 500ms 噪音底線
const PRE = 15;              // 300ms pre-roll,不然會吃掉句首
const HANG = 35;             // 連續靜音 700ms 就切段
const MAXF = 600;            // 硬上限 12 秒強制切段
const MIN_VOICED = 25;       // 有效語音不足 500ms 當雜音丟掉
const MAX_INFLIGHT = 2;      // 同時最多 2 個辨識請求在途

const KEY = 'taigi-caption:';
const el = (id) => document.getElementById(id);
const stage = el('stage');

/* ---------- 設定 ---------- */

const cfg = {
  base: localStorage.getItem(KEY + 'base') || '',
  size: +(localStorage.getItem(KEY + 'size') || 100),
  demo: localStorage.getItem(KEY + 'demo') === '1',
};

function apiUrl(path) {
  return (cfg.base ? cfg.base.replace(/\/+$/, '') : '') + path;
}

/* ---------- WAV 編碼(44 byte 標頭 + int16 樣本) ---------- */

function encodeWav(pcm) {
  const bytes = pcm.length * 2;
  const v = new DataView(new ArrayBuffer(44 + bytes));
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);            // PCM
  v.setUint16(22, 1, true);            // 單聲道
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);     // byte rate
  v.setUint16(32, 2, true);            // block align
  v.setUint16(34, 16, true);           // bits
  tag(36, 'data'); v.setUint32(40, bytes, true);
  for (let i = 0, o = 44; i < pcm.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return v.buffer;
}

/* ---------- 線性重取樣到 16kHz(跨 chunk 連續,不留接縫) ---------- */

let rsTail = new Float32Array(0);
let rsFrac = 0;

function resample(chunk, inRate) {
  const ratio = inRate / RATE;
  const buf = new Float32Array(rsTail.length + chunk.length);
  buf.set(rsTail); buf.set(chunk, rsTail.length);
  const out = [];
  let p = rsFrac;
  while (p + 1 < buf.length) {
    const i = p | 0, f = p - i;
    out.push(buf[i] * (1 - f) + buf[i + 1] * f);
    p += ratio;
  }
  const keep = p | 0;
  rsTail = buf.slice(keep);
  rsFrac = p - keep;
  return Float32Array.from(out);
}

/* ---------- VAD:能量法 + 自適應噪音底線 ---------- */

const vad = { warm: [], floor: 0.004, pre: [], frames: [], voiced: 0, silence: 0, on: false, part: new Float32Array(0) };

function resetAudio() {
  rsTail = new Float32Array(0); rsFrac = 0;
  Object.assign(vad, { warm: [], floor: 0.004, pre: [], frames: [], voiced: 0, silence: 0, on: false, part: new Float32Array(0) });
}

// 收到一塊原始音訊(任何取樣率)→ 重取樣 → 切成 20ms frame → 餵 VAD
function onAudio(chunk, inRate) {
  const r = resample(chunk, inRate);
  const buf = new Float32Array(vad.part.length + r.length);
  buf.set(vad.part); buf.set(r, vad.part.length);
  let o = 0;
  while (o + FRAME <= buf.length) { onFrame(buf.subarray(o, o + FRAME)); o += FRAME; }
  vad.part = buf.slice(o);
}

let meterTick = 0;

function frameRms(f) {
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  return Math.sqrt(sum / f.length);
}

function onFrame(f) {
  const rms = frameRms(f);

  if (++meterTick % 3 === 0) el('level-bar').style.width = Math.min(100, Math.round(Math.sqrt(rms) * 220)) + '%';

  if (vad.warm.length < WARM) {                      // 暖機:只量底線,不判斷語音
    vad.warm.push(rms);
    if (vad.warm.length === WARM) {
      const s = vad.warm.slice().sort((a, b) => a - b);
      vad.floor = Math.max(0.0015, s[s.length >> 1]);
    }
    return;
  }

  const open = Math.max(vad.floor * 4, 0.012);
  const close = Math.max(vad.floor * 2, 0.007);      // hysteresis,不然句中停頓會亂切

  if (!vad.on) {
    vad.pre.push(new Float32Array(f));
    if (vad.pre.length > PRE) vad.pre.shift();
    vad.floor = vad.floor * 0.97 + rms * 0.03;       // 只在靜音時緩慢跟隨環境
    if (rms > open) {
      vad.on = true; vad.frames = vad.pre; vad.pre = []; vad.voiced = 1; vad.silence = 0;
      if (!inflight) setStatus('聆聽中,有偵測到聲音', 'live');
    }
    return;
  }

  vad.frames.push(new Float32Array(f));
  if (rms > close) { vad.voiced++; vad.silence = 0; } else { vad.silence++; }

  if (vad.silence >= HANG) { cut(); vad.on = false; vad.pre = []; }
  else if (vad.frames.length >= MAXF) cutForced();   // 強制切,但不停止收音
}

// 硬上限到了但人還在講。不要正好切在「時間到」那一刻,那很容易切在字中間;
// 往回看最近 500ms,挑音量最低的一格下刀,尾巴留給下一段接著用。
// 實測固定秒數硬切會讓模型把半句話讀成別的詞,而且那種錯誤 logprob 過濾器抓不到
// (見 VERIFICATION.md 四之二)。切在相對安靜處加上把上一句當上下文,是兩道互補的補救。
function cutForced() {
  const n = vad.frames.length;
  const look = Math.min(25, n - MIN_VOICED);
  if (look <= 0) { cut(); vad.silence = 0; return; }
  let best = n - 1, bestRms = Infinity;
  for (let i = n - look; i < n; i++) {
    const r = frameRms(vad.frames[i]);
    if (r < bestRms) { bestRms = r; best = i; }
  }
  const tail = vad.frames.slice(best);
  vad.frames = vad.frames.slice(0, best);
  cut();                        // cut 會清空 frames 並送出前半段
  vad.frames = tail;            // 後半段留著,下一次切段才不會少掉這段聲音
  vad.voiced = tail.length;     // 保守估:尾巴都算有聲,免得下一段被當雜音丟掉
  vad.silence = 0;
}

function cut() {
  const frames = vad.frames, voiced = vad.voiced;
  vad.frames = []; vad.voiced = 0; vad.silence = 0;
  if (voiced < MIN_VOICED) return;                   // 太短,當雜音
  const pcm = new Float32Array(frames.length * FRAME);
  frames.forEach((f, i) => pcm.set(f, i * FRAME));
  send(pcm);
}

/* ---------- 上傳佇列 ---------- */

let seq = 0, inflight = 0;
const queue = [];

// 上一句已確定的字幕,當成下一段的上下文送回後端(後端拿它當 initial_prompt)。
// 實測:切在句中時,同一段音檔沒有上下文會被讀成整句捏造的「採訪撰稿人 金汝外交官」,
// 給了上一句之後就變成正確的「台灣台語輸入法App 透過語音辨識...」。理由見 VERIFICATION.md 四之三。
// 只記通過後端過濾器的字幕:幻聽不該被當上下文傳染給下一句。
let lastText = '';

function send(pcm) {
  // ponytail: 顯示順序不需要排序邏輯。占位節點在切段當下就插進 DOM,
  // 所以 DOM 順序天生等於說話順序;回應亂序回來也只是各自填自己的節點。
  const job = { n: ++seq, pcm, node: addLine('辨識中', 'pending') };
  queue.push(job);
  pump();
}

function pump() {
  while (inflight < MAX_INFLIGHT && queue.length) {
    inflight++;
    post(queue.shift()).catch(() => {}).then(() => { inflight--; pump(); idle(); });
  }
  if (inflight) setStatus('辨識中', 'work');
}

async function post(job) {
  try {
    const q = lastText ? '?prev=' + encodeURIComponent(lastText.slice(-200)) : '';
    const r = await fetch(apiUrl('/transcribe' + q), {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: encodeWav(job.pcm),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('後端回應 ' + r.status));
    const text = (data.text || '').trim();
    if (text) { fillLine(job.node, text); lastText = text; }
    else job.node.remove();                          // 後端判定這段是雜音或幻聽
  } catch (e) {
    fillLine(job.node, humanError(e), 'bad');
  }
}

function humanError(e) {
  if (e instanceof TypeError) return '後端沒回應,請確認伺服器位址(設定裡可以改)。';
  return String(e.message || e);
}

/* ---------- 畫面 ---------- */

function addLine(text, cls) {
  const hint = el('hint');
  if (hint) hint.remove();
  const p = document.createElement('p');
  p.className = 'line' + (cls ? ' ' + cls : '');
  p.textContent = text;
  stage.append(p);
  stage.scrollTop = stage.scrollHeight;
  return p;
}

function fillLine(node, text, cls) {
  node.className = 'line' + (cls ? ' ' + cls : '');
  node.textContent = text;
  stage.scrollTop = stage.scrollHeight;
}

function setStatus(text, tone) {
  const s = el('status');
  s.textContent = text;
  s.dataset.tone = tone || 'idle';
}

function idle() {
  if (inflight) return;
  setStatus(running ? '聆聽中' : '待機', running ? 'live' : 'idle');
}

/* ---------- 收音 ---------- */

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
`;

async function makeTap(ctx) {
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const n = new AudioWorkletNode(ctx, 'tap');
    n.port.onmessage = (e) => onAudio(e.data, ctx.sampleRate);
    return n;
  } catch (e) {
    // ponytail: 退回已廢棄的 ScriptProcessorNode(舊版 iOS Safari 只有這條路)。
    // 天花板:它跑在主執行緒,主執行緒忙的時候會掉樣本,VAD 就可能提早切句。
    const n = ctx.createScriptProcessor(4096, 1, 1);
    n.onaudioprocess = (e) => onAudio(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate);
    return n;
  }
}

let running = false, audio = null, demoTimer = 0;

async function start() {
  resetAudio();
  lastText = '';                                     // 新的一場不要接上一場的上下文
  running = true;
  el('toggle').textContent = '停止';
  el('toggle').dataset.on = '1';
  el('toggle').setAttribute('aria-label', '停止聆聽');

  if (cfg.demo) { startDemo(); return; }

  setStatus('正在要麥克風權限', 'work');
  try {
    // 加逾時:實測 Chrome 偶爾會在取得音訊裝置時整個卡住,getUserMedia 既不 resolve 也不 reject,
    // 沒有逾時的話畫面就永遠停在「正在要麥克風權限」,使用者只看到當掉。
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('麥克風一直沒有回應。請重新整理頁面再按開始,或確認沒有其他程式佔用麥克風。')), 15000),
      ),
    ]);
    if (!running) { stream.getTracks().forEach((t) => t.stop()); return; }  // 權限泡泡還開著就按了停止
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const tap = await makeTap(ctx);
    const mute = ctx.createGain();
    mute.gain.value = 0;                             // ScriptProcessor 要接到 destination 才會跑
    ctx.createMediaStreamSource(stream).connect(tap);
    tap.connect(mute).connect(ctx.destination);
    audio = { stream, ctx, tap };
    setStatus('聆聽中', 'live');
  } catch (e) {
    running = false;
    reset();
    const deny = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    addLine(deny ? '沒有麥克風權限。請在瀏覽器的網站設定裡允許麥克風,再按開始。'
                 : '打不開麥克風:' + (e && e.message ? e.message : e), 'bad');
    setStatus('麥克風打不開', 'bad');
  }
}

function stop() {
  running = false;
  clearInterval(demoTimer); demoTimer = 0;
  if (audio) {
    audio.tap.disconnect();
    if (audio.tap.port) audio.tap.port.onmessage = null; else audio.tap.onaudioprocess = null;
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close();
    audio = null;
  }
  reset();
  setStatus('待機', 'idle');
}

function reset() {
  el('toggle').textContent = '開始';
  el('toggle').dataset.on = '0';
  el('toggle').setAttribute('aria-label', '開始聆聽台語');
  el('level-bar').style.width = '0%';
}

/* ---------- 示範模式 ---------- */

const DEMO = [
  '今天天氣很好,要不要出去走走',
  '你吃飽了嗎',
  '我明天要去台北出差',
  '這個孩子真乖',
  '阿嬤說湯要趁熱喝',
];

function startDemo() {
  setStatus('示範模式:畫面是預錄的假字幕,沒有連後端', 'work');
  let i = 0;
  demoTimer = setInterval(() => {
    addLine(DEMO[i++ % DEMO.length], 'demo');
    el('level-bar').style.width = (30 + Math.round(Math.random() * 60)) + '%';
  }, 2600);
}

/* ---------- 後端狀態 ---------- */

async function health() {
  const pill = el('backend');
  if (cfg.demo) { pill.textContent = '後端:示範模式'; pill.dataset.tone = 'idle'; return; }
  if (!navigator.onLine) { pill.textContent = '後端:裝置離線'; pill.dataset.tone = 'bad'; return; }
  try {
    const r = await fetch(apiUrl('/health'), { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok) throw new Error('後端說自己沒準備好');
    pill.textContent = '後端:就緒(' + (d.device || '?') + ')';
    pill.dataset.tone = 'ok';
    pill.title = d.model || '';
  } catch (e) {
    pill.textContent = '後端:連不上';
    pill.dataset.tone = 'bad';
    pill.title = humanError(e);
  }
}

/* ---------- 啟動 ---------- */

function applySize(v) {
  document.documentElement.style.setProperty('--cap', v / 100);
  el('fontsize-out').textContent = v + '%';
}

function init() {
  el('base').value = cfg.base;
  el('fontsize').value = cfg.size;
  el('demo').checked = cfg.demo;
  applySize(cfg.size);

  el('toggle').addEventListener('click', () => (running ? stop() : start()));

  el('base').addEventListener('change', (e) => {
    cfg.base = e.target.value.trim();
    localStorage.setItem(KEY + 'base', cfg.base);
    health();
  });

  el('fontsize').addEventListener('input', (e) => {
    cfg.size = +e.target.value;
    localStorage.setItem(KEY + 'size', cfg.size);
    applySize(cfg.size);
  });

  el('demo').addEventListener('change', (e) => {
    cfg.demo = e.target.checked;
    localStorage.setItem(KEY + 'demo', cfg.demo ? '1' : '0');
    if (running) stop();
    health();
  });

  if (!window.isSecureContext || !navigator.mediaDevices) {
    const n = el('insecure');
    n.hidden = false;
    n.textContent = '瀏覽器只在 HTTPS 或 localhost 允許使用麥克風,請用 https 連線(見 README 的自簽憑證說明)。';
    el('toggle').disabled = true;
    setStatus('這個網址不能用麥克風', 'bad');
  }

  addEventListener('offline', health);
  addEventListener('online', health);
  health();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();

// 給 console 自我檢查用的入口,見 selfcheck.md
window.__taigi = { onAudio, resample, encodeWav, cut, cutForced, frameRms, vad, cfg, start, stop, apiUrl, makeTap, resetAudio, get inflight() { return inflight; }, get lastText() { return lastText; } };
