"""最小檢查:只驗不需要模型的邏輯,不載入真權重。

跑法:.venv/bin/python test_server.py
函式用 test_ 開頭,所以裝了 pytest 的環境也能 pytest test_server.py -q,本專案 venv 沒裝,
預設走底下的 __main__。

ponytail: 這是「邏輯壞掉就會紅」的一個檢查,不是測試矩陣。真模型的品質靠 bench.py 與
VERIFICATION.md 的實測,不靠這裡。
"""

import io
import os
import wave

os.environ.setdefault("TAIGI_DEVICE", "cpu")  # 別讓 import server 去問 GPU

import server


class Seg:
    """假的 faster-whisper segment,只有 keep_segments 會看的三個欄位。"""

    def __init__(self, text, avg_logprob, compression_ratio=1.2):
        self.text = text
        self.avg_logprob = avg_logprob
        self.compression_ratio = compression_ratio


class FakeModel:
    """一句真內容加一段幻聽尾巴,用來驗端點有沒有真的過濾。"""

    def transcribe(self, audio, **kw):
        return iter([Seg("今天天氣很好", -0.14), Seg("我會好好地珍惜 將來的日子", -1.52)]), None


def make_wav(seconds=1.0, rate=16000, channels=1, width=2):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(b"\x00" * int(seconds * rate) * channels * width)
    return buf.getvalue()


def test_keep_segments_用實測的_logprob_判真假():
    # 數值全部抄 VERIFICATION.md 量到的真實案例
    segs = [
        Seg("今天天氣很好", -0.14),  # 真內容
        Seg("這段也是真的", -0.89),  # 真內容區間的最低點
        Seg("我會好好地珍惜 將來的日子", -1.52),  # 幻聽尾段
        Seg("來", -1.02),  # 最接近門檻的幻聽,只差 0.02
    ]
    text, dropped = server.keep_segments(segs)
    assert text == "今天天氣很好這段也是真的", text
    assert dropped == 2, dropped


def test_keep_segments_壓縮比規則():
    """重複迴圈型幻聽走 compression_ratio 這條線,不走 logprob。

    誠實記錄一個落差:實測到的迴圈案例是 2.24,而預設門檻 2.4(沿用 Whisper 上游慣例)比它寬,
    所以「吃飯了 吃飯了...」單看壓縮比在預設值下是留下來的。要靠壓縮比擋住它得把
    TAIGI_MAX_CR 調到 2.2 附近。實務上這種段落的 logprob 通常也很低,會先被上面那條線攔掉。
    """
    loop = [Seg("吃飯了 吃飯了 吃飯了", -0.30, compression_ratio=2.24)]
    assert server.keep_segments(loop)[1] == 0, "預設 2.4 比實測的 2.24 寬,這裡本來就不該丟"
    assert server.keep_segments(loop, max_cr=2.2)[1] == 1, "門檻收到 2.2 就該丟掉"


def test_keep_segments_門檻可調():
    segs = [Seg("來", -1.02), Seg("吃飯了 吃飯了", -0.3, compression_ratio=2.24)]
    text, dropped = server.keep_segments(segs, min_logprob=-2.0, max_cr=99.0)
    assert dropped == 0 and text == "來吃飯了 吃飯了", (text, dropped)
    _, dropped = server.keep_segments([Seg("今天天氣很好", -0.14)], min_logprob=-0.1)
    assert dropped == 1, dropped


def test_keep_segments_空串列():
    assert server.keep_segments([]) == ("", 0)


def test_decode_wav_合法輸入():
    audio = server.decode_wav(make_wav(seconds=0.5))
    assert audio.dtype.name == "float32", audio.dtype
    assert len(audio) == 8000, len(audio)


def test_decode_wav_不合法輸入():
    bad = {
        "取樣率不符": make_wav(rate=8000),
        "雙聲道": make_wav(channels=2),
        "非 16-bit": make_wav(width=1),
        "非 WAV": "這不是音檔".encode() * 100,
        "空位元組": b"",
    }
    for name, raw in bad.items():
        try:
            server.decode_wav(raw)
        except ValueError:
            continue
        raise AssertionError(f"{name} 應該要被拒絕,卻通過了")


def test_http_契約():
    from fastapi.testclient import TestClient

    server._model = FakeModel()  # 先塞假的,lifespan 就不會去載真權重
    with TestClient(server.app) as c:
        h = c.get("/health").json()
        assert h == {
            "ok": True,
            "model": server.MODEL,
            "device": server.DEVICE,
            "compute": server.COMPUTE,
            "lang": server.LANG,
        }, h

        r = c.post("/transcribe", content=make_wav(1.0), headers={"content-type": "audio/wav"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["text"] == "今天天氣很好", body
        assert body["dropped"] == 1, body
        assert body["seconds"] == 1.0 and isinstance(body["ms"], int), body

        r = c.post("/transcribe", files={"file": ("a.wav", make_wav(1.0), "audio/wav")})
        assert r.status_code == 200 and r.json()["text"] == "今天天氣很好", r.text

        r = c.post("/transcribe", content=make_wav(0.1), headers={"content-type": "audio/wav"})
        assert r.status_code == 200 and r.json() == {
            "text": "",
            "seconds": 0.1,
            "ms": 0,
            "dropped": 0,
        }, r.text

        r = c.post("/transcribe", content=b"nope", headers={"content-type": "audio/wav"})
        assert r.status_code == 400, r.text

        big = b"\x00" * (server.MAX_BYTES + 1)
        r = c.post("/transcribe", content=big, headers={"content-type": "audio/wav"})
        assert r.status_code == 413, r.status_code


if __name__ == "__main__":
    fails = []
    for name, fn in list(globals().items()):
        if not name.startswith("test_"):
            continue
        try:
            fn()
            print(f"  ok   {name}")
        except Exception as e:
            fails.append(name)
            print(f"  FAIL {name}: {type(e).__name__}: {e}")
    print(f"\n{'全部通過' if not fails else '失敗:' + ', '.join(fails)}")
    raise SystemExit(1 if fails else 0)
