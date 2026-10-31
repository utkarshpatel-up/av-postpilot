#!/usr/bin/env python3
"""
JSON-lines bridge between the Quiet Lift Electron app and quiet_lift.py.

stdin : one command per line   {"id": 1, "cmd": "analyze", ...}
stdout: one message per line   {"id": 1, "type": "log", "msg": "..."}
                               {"id": 1, "type": "result", "data": {...}}
                               {"id": 1, "type": "error", "msg": "..."}

The analysis is kept in memory, so render reuses it without re-reading the files.
Open and render write range markers (QL01, QL02, ...) into the debleed track (optional) and render into
the output too, so the two can be compared marker by marker in Audition / RX. No preview clips are written.
quiet_lift.py is found next to this file, or in QUIET_LIFT_DIR, or two folders up (the repo root when run
from source; the app's resources/ folder when installed, where the build copies it).
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
for d in (os.environ.get("QUIET_LIFT_DIR"), HERE, os.path.dirname(os.path.dirname(HERE))):
    if d and os.path.exists(os.path.join(d, "quiet_lift.py")):
        sys.path.insert(0, d)
        break
import quiet_lift as ql  # noqa: E402
import soundfile as sf  # noqa: E402
import wav_markers  # noqa: E402

EDITORS = {
    "audition": [r"C:\Program Files\Adobe\Adobe Audition*\Adobe Audition.exe"],
    "rx": [r"C:\Program Files\iZotope\RX * Audio Editor\win64\iZotope RX * Audio Editor.exe",
           r"C:\Program Files\iZotope\RX *\win64\iZotope RX *.exe"],
}
MARKER_PREFIX = "QL"
OPTION_KEYS = ["window", "quiet_low", "quiet_high", "floor", "contrast", "removed",
               "min_len", "max_gain", "gate", "word_floor", "ceiling", "release"]

state = {"analysis": None}


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def skips_file(a):
    return a.args.input + ".quietlift.json"


def cmd_defaults(_req, _log):
    d = ql.make_parser().parse_args(["x"])
    return {k: getattr(d, k) for k in OPTION_KEYS}


def cmd_probe(req, _log):
    i = sf.info(req["path"])
    return {"duration": i.duration, "samplerate": i.samplerate, "channels": i.channels, "subtype": i.subtype,
            "size": os.path.getsize(req["path"])}


def cmd_editors(_req, _log):
    found = {}
    for name, patterns in EDITORS.items():
        hits = [h for p in patterns for h in sorted(glob.glob(p))]
        found[name] = hits[-1] if hits else ""
    return found


def cmd_analyze(req, log):
    argv = [req["input"]]
    for key in ("original", "other"):
        if req.get(key):
            argv += ["--" + key, req[key]]
    for k, v in (req.get("options") or {}).items():
        if k in OPTION_KEYS and v not in (None, ""):
            argv += ["--" + k.replace("_", "-"), str(float(v))]
    args = ql.make_parser().parse_args(argv)
    a = ql.analyze(args, log=log)
    state["analysis"] = a

    try:
        with open(skips_file(a), encoding="utf-8") as f:
            saved = json.load(f).get("skipped", [])
    except (OSError, ValueError):
        saved = []
    skipped = [i for i, st in enumerate(a.stretches) if [st.start, st.end] in saved]
    log(f"Found {len(a.stretches)} quiet stretch(es)" + (f", {len(skipped)} skip(s) restored." if skipped else "."))
    return {
        "duration": a.info.duration,
        "ref": a.ref, "lo": a.ref - args.quiet_low, "hi": a.ref - args.quiet_high,
        "step": 0.5,
        "levels": [round(float(x), 1) for x in a.sec],
        "stretches": [{"start": st.start, "end": st.end, "speech": round(st.speech, 1),
                       "gaps": round(st.gaps, 1), "gain": round(st.gain, 1)} for st in a.stretches],
        "skipped": skipped,
        "marked": count_markers(args.input),
    }


def marker_name(i, st, skipped):
    return f"{MARKER_PREFIX}{i + 1:02d} " + ("skipped" if skipped else f"+{st.gain:.1f} dB")


def count_markers(path):
    try:
        return sum(1 for m in wav_markers.read_markers(path) if m[2].startswith(MARKER_PREFIX))
    except (OSError, ValueError, KeyError, IndexError):
        return 0


def need_analysis():
    if state["analysis"] is None:
        raise ValueError("Analyze first.")
    return state["analysis"]


def cmd_skips(req, _log):
    a = need_analysis()
    data = {"skipped": [[a.stretches[i].start, a.stretches[i].end] for i in sorted(req["skipped"])]}
    with open(skips_file(a), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return {"saved": len(data["skipped"])}


def cmd_open(req, log):
    """Open the debleed track (and the lifted file, if given) in the editor.
    With mark_input, the debleed track's QL markers are brought up to date first (current skips)."""
    a = need_analysis()
    exe = req.get("editor_path") or ""
    if not os.path.exists(exe):
        raise ValueError(f"Editor not found: {exe}")
    error = None
    if req.get("mark_input", True) and a.stretches:
        error = write_markers(a, a.args.input, set(req.get("skipped") or []), log)
    files = [a.args.input] + [p for p in [req.get("lifted")] if p and os.path.exists(p)]
    subprocess.Popen([exe, *files], close_fds=True, creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
    log("Opened in editor: " + ", ".join(os.path.basename(p) for p in files))
    return {"files": files, "marker_error": error, "marked": count_markers(a.args.input)}


def write_markers(a, path, skipped, log):
    marks = [(int(round(st.start * a.sr)), int(round((st.end - st.start) * a.sr)), marker_name(i, st, i in skipped))
             for i, st in enumerate(a.stretches)]
    try:
        wav_markers.write_markers(path, marks, MARKER_PREFIX)
    except PermissionError:
        log(f"Could not add markers to {os.path.basename(path)}: it is open in another program.")
        return f"{os.path.basename(path)} is open in another program (close it in the editor and try again)"
    except (OSError, ValueError) as e:
        log(f"Could not add markers to {os.path.basename(path)}: {e}")
        return str(e)
    log(f"Added {len(marks)} marker(s) to {os.path.basename(path)}")
    return None


def cmd_render(req, log):
    a = need_analysis()
    out = os.path.abspath(req["output"])
    inputs = {os.path.abspath(p) for p in (a.args.input, a.args.original, a.args.other) if p}
    if out in inputs:
        raise ValueError("Output can't be one of the input files.")
    skipped = set(req.get("skipped") or [])
    # The output is the input's format, so about its size. Checked first: a full drive otherwise
    # leaves a cut-off file (with no markers) and only libsndfile's "System error."
    need = os.path.getsize(a.args.input) + 64 * 2**20
    free = shutil.disk_usage(os.path.dirname(out)).free + (os.path.getsize(out) if os.path.isfile(out) else 0)
    if free < need:
        raise ValueError(f"Not enough space for {os.path.basename(out)}: it needs about {need // 2**20} MB "
                         f"and {os.path.splitdrive(out)[0] or os.path.dirname(out)} has {free // 2**20} MB free.")
    log(f"Rendering {len(a.stretches) - len(skipped)} stretch(es), skipping {len(skipped)}...")
    try:
        ql.render(a, out, ql.gain_curve(a, skipped))
    except Exception:
        try:
            os.remove(out)   # half a file would pass for a finished render
        except OSError:
            pass
        raise
    log(f"Wrote {out}")
    errors = {"output": write_markers(a, out, skipped, log)}
    if req.get("mark_input", True):
        errors["input"] = write_markers(a, a.args.input, skipped, log)
    return {"output": out, "markers": len(a.stretches), "marker_errors": {k: v for k, v in errors.items() if v},
            "marked_input": bool(req.get("mark_input", True)) and not errors.get("input")}


COMMANDS = {"defaults": cmd_defaults, "probe": cmd_probe, "editors": cmd_editors, "analyze": cmd_analyze,
            "skips": cmd_skips, "open": cmd_open, "render": cmd_render}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    send({"type": "ready"})
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            data = COMMANDS[req["cmd"]](req, lambda m, rid=rid: send({"id": rid, "type": "log", "msg": m}))
            send({"id": rid, "type": "result", "data": data})
        except Exception as e:  # noqa: BLE001 - report every failure to the UI
            sys.stderr.write(traceback.format_exc())
            send({"id": rid, "type": "error", "msg": str(e) or type(e).__name__})


if __name__ == "__main__":
    main()
