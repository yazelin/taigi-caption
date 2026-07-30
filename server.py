"""台語即時字幕後端:台語語音進,繁體中文文字出。

一個 process 同時服務前端靜態檔與 /transcribe API,所以手機只要連一個位址,不用處理 CORS。
模型 Breeze-ASR-26 本身就把台語語音轉寫成華語用字的繁體中文,ASR 與台到中翻譯一步完成。

跑法見 scripts/run.sh。實測數字與門檻的來由見 VERIFICATION.md。
"""

import asyncio
import io
import os
import time
import wave
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")

RATE = 16000
MAX_BYTES = 25 * 1024 * 1024
MIN_SECONDS = 0.2

MODEL = os.environ.get("TAIGI_MODEL", "WizardForest/faster-whisper-Breeze-ASR-26-int8")

# 語言 token 預設 en,這不是筆誤:它只是解碼時的條件 token,輸出仍然是繁體中文。
# 官方 model card 沒有給 usage 範例,而 config.json 的 forced_decoder_ids 寫的是 <|en|>(50259),
# generation_config.json 的語言槽卻是 null,所以我們自己在 17 段音檔(14 段行政院真人台語廣播
# 加 3 段合成)上量:en 平均 CER 29.7%、zh 30.4%,成對比較 en 勝 10 場、zh 勝 4 場、平手 3 場。
# 差距不大且中位數其實略偏 zh,所以這是「有證據的預設」而不是定論,換 zh 或 auto 都合理。
# auto 不建議:會多花約 45% 時間做語言偵測,而且偵測結果是錯的(回報緬甸語,信心 0.13)。
# 量法見 bench.py,細節見 VERIFICATION.md 第二節。
LANG = os.environ.get("TAIGI_LANG", "en")

# 幻聽門檻。-1.0 這條線離最接近的真實案例(-1.02)只差 0.02,邊界很窄,所以留成環境變數。
MIN_LOGPROB = float(os.environ.get("TAIGI_MIN_LOGPROB", "-1.0"))
MAX_CR = float(os.environ.get("TAIGI_MAX_CR", "2.4"))

BEAM = int(os.environ.get("TAIGI_BEAM", "1"))  # 即時優先,beam 越大越慢

# 上一句字幕當上下文餵回模型(initial_prompt)。實測有效:固定切段時整句捏造的
# 「採訪撰稿人 金汝外交官」(avg_logprob -0.93,過濾器擋不掉)在給了前一句之後
# 變成正確的「台灣台語輸入法App 透過語音辨識...」(-0.24),其餘各段 logprob 也一併變好。
# 設 0 可關閉。只取尾端這麼多字,太長的上下文沒有幫助又會拖慢 prompt 處理。
PROMPT_CHARS = int(os.environ.get("TAIGI_PROMPT_CHARS", "200"))
CPU_THREADS = int(os.environ.get("TAIGI_CPU_THREADS") or min(8, os.cpu_count() or 4))


def _pick_device() -> str:
    d = os.environ.get("TAIGI_DEVICE", "auto")
    if d != "auto":
        return d
    try:
        import ctranslate2

        return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    except Exception:
        return "cpu"


DEVICE = _pick_device()
COMPUTE = os.environ.get("TAIGI_COMPUTE") or ("int8_float16" if DEVICE == "cuda" else "int8")

# ponytail: 單機單模型,只有一份權重在 VRAM 裡,所以同時進模型的請求刻意壓在 2 個,其餘排隊。
# 要給多人同時用再上多 worker 或外部佇列(Redis/RQ 之類),不要在這裡加排程器。
SEM = asyncio.Semaphore(2)


def decode_wav(raw: bytes) -> np.ndarray:
    """把 WAV 位元組解成 float32 波形。只吃 16-bit PCM 單聲道 16000Hz,不合規就 raise ValueError。

    刻意用內建 wave 模組:不依賴 ffmpeg、不寫暫存檔。
    ponytail: 前端本來就用 AudioContext 產這個格式,後端沒有理由為了通吃格式而多背一個轉檔器。
    """
    try:
        with wave.open(io.BytesIO(raw), "rb") as w:
            params = w.getparams()
            frames = w.readframes(params.nframes)
    except Exception as e:
        raise ValueError(f"不是有效的 WAV 檔:{e}") from e
    if params.sampwidth != 2:
        raise ValueError(f"需要 16-bit PCM,收到 {params.sampwidth * 8}-bit")
    if params.nchannels != 1:
        raise ValueError(f"需要單聲道,收到 {params.nchannels} 聲道")
    if params.framerate != RATE:
        raise ValueError(f"需要 {RATE}Hz 取樣率,收到 {params.framerate}Hz")
    frames = frames[: len(frames) // 2 * 2]  # 截掉半個 sample 的尾巴,避免 frombuffer 爆掉
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def keep_segments(segments, min_logprob=None, max_cr=None):
    """逐段過濾幻聽,回傳 (字幕文字, 被丟掉的段數)。純函式,測試直接餵假 segment。

    判準全部來自 VERIFICATION.md 第四節的實測,不是猜的:
    1. no_speech_prob 在這顆模型上恆為 0.00,完全不能當依據,所以這裡不看它。
    2. 餵雜訊模型會編句子(三秒隨機雜訊被辨識成「老闆,謝謝」)。
    3. 幻聽幾乎都獨立長成最後一個很短的 segment(30 秒窗的尾巴被填充成新窗),
       而 avg_logprob 差距很大:真內容 -0.02 到 -0.89,幻聽 -1.02 到 -1.97。
    4. 重複迴圈型幻聽(「吃飯了... 吃飯了...」)會讓 compression_ratio 衝到 2.24。
       注意預設門檻 2.4 沿用 Whisper 上游慣例,比實測到的 2.24 寬,所以迴圈段通常是被
       第 3 條的 logprob 攔下來的。要讓壓縮比自己攔住它,得把 TAIGI_MAX_CR 收到 2.2 附近。

    所以是逐段丟,不是判斷整次回應:一段幻聽尾巴不該讓整句真內容消失。
    """
    lo = MIN_LOGPROB if min_logprob is None else min_logprob
    cr = MAX_CR if max_cr is None else max_cr
    kept, dropped = [], 0
    for s in segments:
        if s.avg_logprob < lo or s.compression_ratio > cr:
            dropped += 1
        else:
            kept.append(s.text)
    return "".join(kept).strip(), dropped


_model = None  # 測試會先塞假的進來,get_model 就不會去載真權重


def get_model():
    global _model
    if _model is not None:
        return _model
    from faster_whisper import WhisperModel

    _model = WhisperModel(
        MODEL, device=DEVICE, compute_type=COMPUTE, num_workers=1, cpu_threads=CPU_THREADS
    )
    # 暖機:實測冷啟動第一次推論 728ms、之後 374ms,不暖機的話第一個使用者會吃到冷啟動延遲。
    # 走 _run 而不是自己拼參數,才會暖到真正在用的那條路徑。
    _run(np.zeros(RATE, dtype=np.float32))
    return _model


def _run(audio: np.ndarray, prompt: str | None = None):
    segs, _info = get_model().transcribe(
        audio,
        language=None if LANG == "auto" else LANG,
        beam_size=BEAM,
        vad_filter=False,  # 前端已經做過 VAD 切段,後端再切會吃掉字
        # 這兩個看起來衝突,其實管不同的事(對過 faster_whisper/transcribe.py 的實作):
        # condition_on_previous_text=False 是不讓同一次呼叫裡前一個 30 秒窗的輸出自動接到下一個窗,
        # 避免錯誤滾雪球;initial_prompt 是呼叫方明確給的上下文,只作用在第一個窗。
        # 逐句字幕每段都遠短於 30 秒,只有一個窗,所以 prompt 一定生效、又不會被自動接續污染。
        condition_on_previous_text=False,
        without_timestamps=True,
        initial_prompt=prompt or None,
    )
    return list(segs)  # 推論其實發生在耗盡這個 generator 的時候,所以要在 worker thread 裡 list()


@asynccontextmanager
async def lifespan(_app):
    print(f"載入模型 {MODEL}({DEVICE}/{COMPUTE},language={LANG})")
    t0 = time.perf_counter()
    get_model()
    print(f"模型就緒,含暖機 {time.perf_counter() - t0:.1f} 秒")
    yield


app = FastAPI(title="台語即時字幕", lifespan=lifespan)

# 開放任意來源打 API,讓別人可以把自己的前端指過來。這裡沒有帳號也沒有 cookie,沒有 CSRF 面。
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "device": DEVICE, "compute": COMPUTE, "lang": LANG}


@app.post("/transcribe")
async def transcribe(request: Request, prev: str = ""):
    """接 Content-Type audio/wav 的原始位元組,或 multipart 的 file 欄位,兩種都行。

    查詢參數 prev 是選填的上下文:前端把「上一句已確定的字幕」傳回來,
    當成 initial_prompt 幫模型接上句意。只可以傳通過過濾器的字幕,
    否則會把幻聽當上下文傳染給下一句(理由見 VERIFICATION.md 四之三)。
    """
    if int(request.headers.get("content-length") or 0) > MAX_BYTES:
        raise HTTPException(413, f"音檔超過 {MAX_BYTES // 1024 // 1024}MB 上限")
    if request.headers.get("content-type", "").startswith("multipart/"):
        f = (await request.form()).get("file")
        if f is None or isinstance(f, str):
            raise HTTPException(400, "multipart 缺少 file 欄位")
        raw = await f.read()
    else:
        raw = await request.body()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, f"音檔超過 {MAX_BYTES // 1024 // 1024}MB 上限")

    try:
        audio = decode_wav(raw)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    seconds = round(len(audio) / RATE, 3)
    if seconds < MIN_SECONDS:
        return {"text": "", "seconds": seconds, "ms": 0, "dropped": 0}

    prompt = prev[-PROMPT_CHARS:] if (PROMPT_CHARS > 0 and prev) else None

    t0 = time.perf_counter()
    async with SEM:
        segments = await asyncio.to_thread(_run, audio, prompt)
    text, dropped = keep_segments(segments)
    return {
        "text": text,
        "seconds": seconds,
        "ms": round((time.perf_counter() - t0) * 1000),
        "dropped": dropped,
    }


# 掛在最後:mount 在 / 會吃掉所有沒對上的路徑,放前面 API 就進不來了。
# check_dir=False 是為了讓 web/ 還沒生出來時 server 仍然起得來。
app.mount("/", StaticFiles(directory=WEB, html=True, check_dir=False), name="web")
