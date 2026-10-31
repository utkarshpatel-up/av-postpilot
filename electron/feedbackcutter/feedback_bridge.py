#!/usr/bin/env python3
"""
JSON-lines bridge between PostPilot's Feedback Cutter page and dsp.py.

usage : feedback_bridge.py WORK_DIR
stdin : one command per line   {"id": 1, "cmd": "analyze", ...}
stdout: one message per line   {"id": 1, "type": "log", "msg": "...", "pct": 40}
                               {"id": 1, "type": "result", "data": {...}}
                               {"id": 1, "type": "error", "msg": "..."}

Each analysis gets its own job folder under WORK_DIR with full-length WAVs (original, cleaned,
removed), small MP3 previews and the spectrogram PNGs. Only the current job is kept: a two-hour
recording makes several GB of WAVs, so older jobs are removed when a new one starts.
"""
import json
import os
import re
import shutil
import sys
import traceback
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dsp  # noqa: E402

WORK = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "work"))
JOB_RE = re.compile(r"[0-9a-f]{12}")


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def clear_jobs(keep=None):
    if not os.path.isdir(WORK):
        return
    for name in os.listdir(WORK):
        if JOB_RE.fullmatch(name) and name != keep:
            shutil.rmtree(os.path.join(WORK, name), ignore_errors=True)


def job_dir(job):
    if not isinstance(job, str) or not JOB_RE.fullmatch(job):
        raise ValueError("bad job")
    d = os.path.join(WORK, job)
    if not os.path.isdir(d):
        raise ValueError("This analysis is gone. Analyze the file again.")
    return d


def cmd_check(_req, _log):
    # dsp falls back to a bare "ffmpeg" when it found none; previews and non-WAV input need it
    found = os.path.isfile(dsp.FFMPEG) or shutil.which(dsp.FFMPEG) is not None
    return {"ffmpeg": dsp.FFMPEG if found else None, "work": WORK, "builtin": bool(getattr(sys, "frozen", False))}


def cmd_analyze(req, log):
    in_path = req.get("path")
    if not in_path or not os.path.isfile(in_path):
        raise ValueError(f"File not found: {in_path}")
    clear_jobs()
    job = uuid.uuid4().hex[:12]
    d = os.path.join(WORK, job)
    os.makedirs(d, exist_ok=True)
    params = dict(min_prom_db=float(req.get("sensitivity_db", 22.0)),
                  notch_bw_hz=float(req.get("notch_bw_hz", 20.0)),
                  max_atten_db=float(req.get("atten_db", 48.0)))
    if int(req.get("max_spec_cols") or 0) > 0:
        params["max_spec_cols"] = int(req["max_spec_cols"])
    try:
        result = dsp.process(in_path, d, params=params, progress=lambda msg, pct: log(msg, pct))
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    result.update(job=job, dir=d, filename=os.path.basename(in_path), path=in_path)
    with open(os.path.join(d, "result.json"), "w") as fh:
        json.dump(result, fh)
    return result


def cmd_renotch(req, log):
    d = job_dir(req.get("job"))
    params = dict(notch_bw_hz=float(req.get("notch_bw_hz", 20.0)),
                  max_atten_db=float(req.get("atten_db", 48.0)))
    if int(req.get("max_spec_cols") or 0) > 0:
        params["max_spec_cols"] = int(req["max_spec_cols"])
    events = req.get("events") or []
    log(f"Notching {len(events)} event(s)", None)
    return dsp.renotch(d, events, params=params)


def cmd_clear(_req, _log):
    clear_jobs()
    return {}


COMMANDS = {"check": cmd_check, "analyze": cmd_analyze, "renotch": cmd_renotch, "clear": cmd_clear}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    os.makedirs(WORK, exist_ok=True)
    clear_jobs()   # left over from the last session: the page can't reopen them
    send({"type": "ready"})
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            log = lambda m, pct=None, rid=rid: send({"id": rid, "type": "log", "msg": m, "pct": pct})  # noqa: E731
            send({"id": rid, "type": "result", "data": COMMANDS[req["cmd"]](req, log)})
        except Exception as e:  # noqa: BLE001 - report every failure to the UI
            sys.stderr.write(traceback.format_exc())
            send({"id": rid, "type": "error", "msg": str(e) or type(e).__name__})


if __name__ == "__main__":
    main()
