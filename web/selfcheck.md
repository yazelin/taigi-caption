# 前端自我檢查

不需要麥克風、不需要測試框架,也不需要 GPU。開著頁面,在瀏覽器主控台貼下面的程式碼就能驗
「重取樣、WAV 編碼、音量計算、VAD 切段」這四件事有沒有壞。

入口是 `window.__taigi`(見 `app.js` 最後一行)。下面每一段都附實際跑出來的輸出,
數字對不上就是有東西壞了。整條路(含真的辨識)要驗的話用 `scripts/e2e-check.mjs`,那支會開真瀏覽器加假麥克風。

```js
const t = window.__taigi;

// 1) 重取樣:48kHz 餵一秒,應該得到約 16000 個樣本
t.resetAudio();
t.resample(new Float32Array(48000), 48000).length;
// 實測:16000

// 2) WAV 編碼:標頭要是 RIFF/WAVE,16000Hz、單聲道、16-bit,長度是 44 + 樣本數 * 2
const buf = t.encodeWav(new Float32Array(16000));
const dv = new DataView(buf);
[String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3)),
 buf.byteLength, dv.getUint32(24,true), dv.getUint16(22,true), dv.getUint16(34,true)];
// 實測:["RIFF", 32044, 16000, 1, 16]

// 3) 音量:0.5 振幅的正弦波 RMS 約 0.355,靜音是 0
[t.frameRms(Float32Array.from({length:320}, (_,i) => Math.sin(i/8)*0.5)).toFixed(3),
 t.frameRms(new Float32Array(320)).toFixed(3)];
// 實測:["0.355", "0.000"]

// 4) VAD 切段:靜音暖機 → 有聲 → 靜音,最後應該切出一段並歸零
const chunk = (fn, n) => Float32Array.from({length:n}, (_,i) => fn(i));
t.resetAudio();
t.onAudio(chunk(() => 0, 16000), 16000);                  // 1 秒靜音:量噪音底線
[t.vad.warm.length, t.vad.floor.toFixed(4)];
// 實測:[25, "0.0007"](暖機需要 25 個 frame,也就是 500ms)

t.onAudio(chunk(i => Math.sin(i/8)*0.4, 16000*2), 16000); // 2 秒有聲
[t.vad.on, t.vad.frames.length, t.vad.voiced];
// 實測:[true, 113, 99]

t.onAudio(chunk(() => 0, 16000), 16000);                  // 1 秒靜音:應觸發切段
[t.vad.on, t.vad.frames.length];
// 實測:[false, 0]  切完段就歸零,等下一句
```

第 4 步如果沒有連到後端,切出來的段落會送出 POST 然後在畫面上留下一行錯誤訊息,那是正常的,
這一步只在驗 VAD 的狀態機,不在驗辨識。

其他可用的入口:`t.cut()` 手動切段、`t.cutForced()` 模擬硬上限切段(會往回找最安靜的位置下刀)、
`t.vad` 看完整狀態、`t.lastText` 看目前會被當上下文送回後端的字幕、`t.apiUrl('/health')` 看實際要打的位址。
