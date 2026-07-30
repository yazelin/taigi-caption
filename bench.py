"""比較不同語言 token 的辨識結果,並在有華語對照時算 CER。

用法:
    .venv/bin/python bench.py                  # 跑 testdata/ 下所有 manifest*.json
    .venv/bin/python bench.py --langs zh en     # 只比這兩種
    .venv/bin/python bench.py --device cpu

為什麼需要這支:Breeze-ASR-26 的 config.json 把語言 token 寫成 <|en|>,
generation_config.json 的語言槽卻是 null,官方 model card 沒給 usage 範例。
與其猜,不如讓每個人用自己的音檔實測。
"""

import argparse
import glob
import json
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.environ.get("TAIGI_MODEL", "WizardForest/faster-whisper-Breeze-ASR-26-int8")


def cer(ref: str, hyp: str) -> float:
    """字元錯誤率 = (插入 + 刪除 + 取代) / 參考字數。Levenshtein,單列滾動。"""
    ref = "".join(ref.split())
    hyp = "".join(hyp.split())
    if not ref:
        return float("nan")
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i]
        for j, h in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h)))
        prev = cur
    return prev[-1] / len(ref)


def load_clips():
    clips = []
    for path in sorted(glob.glob(os.path.join(HERE, "testdata", "manifest*.json"))):
        for row in json.load(open(path, encoding="utf-8")):
            wav = row["file"] if os.path.isabs(row["file"]) else os.path.join(HERE, row["file"])
            if os.path.exists(wav):
                clips.append({**row, "wav": wav})
            else:
                print(f"  略過(檔案不存在):{row['file']}")
    return clips


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--langs", nargs="+", default=["zh", "en", "auto"])
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--device", default=os.environ.get("TAIGI_DEVICE", "auto"))
    ap.add_argument("--compute", default=os.environ.get("TAIGI_COMPUTE", ""))
    ap.add_argument(
        "--no-filter",
        action="store_true",
        help="不套用防幻聽過濾器,量原始輸出。用來看過濾器到底幫了多少",
    )
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    # 用 server.py 的同一個過濾函式,不要自己另寫一份。
    # 評測若不套用 production 的過濾器,量到的就不是使用者真正看到的字幕。
    from server import keep_segments

    device = args.device
    if device == "auto":
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            device = "cpu"
    compute = args.compute or ("int8_float16" if device == "cuda" else "int8")

    clips = load_clips()
    if not clips:
        print("testdata/ 沒有音檔。放進 wav 並寫一份 manifest*.json(欄位見 README)。")
        return
    print(f"模型 {args.model}  裝置 {device}/{compute}  音檔 {len(clips)} 段\n")

    model = WhisperModel(args.model, device=device, compute_type=compute)
    table = {}
    for lang in args.langs:
        rows, total_ms = [], 0.0
        print(f"===== language={lang} =====")
        for c in clips:
            t0 = time.time()
            segs, info = model.transcribe(
                c["wav"],
                language=None if lang == "auto" else lang,
                beam_size=1,
                without_timestamps=True,
                condition_on_previous_text=False,
                vad_filter=False,
            )
            if args.no_filter:
                hyp, dropped = "".join(s.text for s in segs).strip(), 0
            else:
                hyp, dropped = keep_segments(list(segs))
            ms = (time.time() - t0) * 1000
            total_ms += ms
            ref = c.get("ref_text") or ""
            same_orth = c.get("ref_orthography") == "mandarin_chars"
            score = cer(ref, hyp) if (ref and same_orth) else None
            rows.append(score)
            mark = f"CER {score:6.1%}" if score is not None else "無華語對照"
            drop_mark = f" 丟{dropped}段" if dropped else ""
            print(f"  {os.path.basename(c['wav']):<22} {mark}{drop_mark}  {ms:5.0f}ms  {hyp}")
            if ref:
                print(f"  {'':<22} 對照({c.get('ref_orthography')}): {ref}")
        scored = [r for r in rows if r is not None]
        avg = sum(scored) / len(scored) if scored else float("nan")
        table[lang] = (avg, len(scored), total_ms / len(clips))
        print(f"  -> 平均 CER {avg:.1%}({len(scored)} 段可算)  平均 {total_ms / len(clips):.0f}ms\n")

    print("===== 總結 =====")
    for lang, (avg, n, ms) in sorted(table.items(), key=lambda kv: kv[1][0]):
        print(f"  {lang:<5} 平均 CER {avg:6.1%}  可算 {n} 段  平均 {ms:5.0f}ms")
    print("\n注意:合成語音對這顆模型是寬鬆條件(它的訓練語料本身就是合成語音),")
    print("所以 testdata 裡混了合成音檔時,平均值會被拉低,看逐段數字比看平均可靠。")
    print("參考點:官方 Taigi ASR Benchmark 平均 CER 是 30.13%;本專案用 14 段行政院真人")
    print("台語廣播加 3 段合成音檔量到 zh 30.4% / en 29.7%,與官方同一量級。詳見 VERIFICATION.md。")


if __name__ == "__main__":
    main()
