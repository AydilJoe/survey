"""Voice-over for the tax video, with Piper (free, offline neural TTS).

Reads a script JSON ([{id, text}]), speaks each line, and writes:
  narration.wav  every line in order, with a short gap between lines
  timing.json    {lines: [{id, start, end}], total}: the video's beats

  PIPER=…/piper VOICE=…/en_US-lessac-high.onnx python3 tts.py script.json outdir
"""
import json, os, subprocess, sys, wave

script, out = sys.argv[1], sys.argv[2]
piper, voice = os.environ["PIPER"], os.environ["VOICE"]
speed = os.environ.get("LENGTH_SCALE", "0.95")   # <1 is faster
lead, gap, tail = 0.6, 0.35, 0.4                 # seconds
os.makedirs(out, exist_ok=True)

lines = json.load(open(script))
frames, rate, params, t, timing = [], None, None, lead, []
for ln in lines:
    path = os.path.join(out, f"line-{ln['id']}.wav")
    subprocess.run([piper, "-m", voice, "-f", path, "--length-scale", speed],
                   input=ln["text"].encode(), check=True, stderr=subprocess.DEVNULL)
    with wave.open(path) as w:
        params = params or w.getparams()
        rate = w.getframerate()
        data = w.readframes(w.getnframes())
        dur = w.getnframes() / rate
    frames.append((t, data))
    timing.append({"id": ln["id"], "start": round(t, 3), "end": round(t + dur, 3)})
    t += dur + gap
total = t - gap + tail

width = params.sampwidth
buf = bytearray(int(total * rate) * width)
for start, data in frames:
    i = int(start * rate) * width
    buf[i:i + len(data)] = data
with wave.open(os.path.join(out, "narration.wav"), "wb") as w:
    w.setparams(params)
    w.writeframes(bytes(buf))
json.dump({"lines": timing, "total": round(total, 3)}, open(os.path.join(out, "timing.json"), "w"), indent=1)
print(json.dumps({"total": round(total, 2), "lines": [(x["id"], x["start"], x["end"]) for x in timing]}))
