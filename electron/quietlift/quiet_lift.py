#!/usr/bin/env python3
"""
quiet_lift.py v2 - raise ONLY long quiet stretches of speech, and only the words in them.

How it decides:
  1. Every 0.5 s it measures how loud the SPEECH is in the surrounding --window
     seconds (default 10 s), using the loud end of the level range (90th percentile
     of 50 ms levels). Gaps and debleed residue don't pull this number down.
  2. The typical speech level of the whole file (median of those) is the reference.
  3. A stretch counts as QUIET only if it is between --quiet-high and --quiet-low dB
     below the reference (default 6 to 16 dB below) for at least --min-len seconds
     (default 8 s). Normal speech that dips a little is never touched.
     It must also look like real talking: words at least --contrast dB (default 15)
     above the gaps between them. Debleed residue with a stray word is rejected.
     --floor -33 (optional) rejects anything quieter than that outright.
  4. Inside a quiet stretch, gain is applied ONLY while someone is talking (the 50 ms
     level is near the speech level AND at least --word-floor dB, default 12, above the
     stretch's gaps). Gaps / debleed residue stay at their original level.
     Everything outside quiet stretches is passed through bit-for-bit.
  5. A limiter (--ceiling, default -6.3 dBFS) works only on the raised words.

Usage:
  python quiet_lift.py input.wav --analyze        # report only, changes nothing
  python quiet_lift.py input.wav output.wav
  python quiet_lift.py debleed.wav output.wav --original original.wav --other other_mic.wav   # most accurate
  python quiet_lift.py input.wav output.wav --skip 1:15:00-1:15:25 --skip 0:42:10-0:42:40

  The Quiet Lift desktop app (app/) is a GUI on top of this file (it imports analyze / gain_curve / render).

Needs:  pip install numpy soundfile
"""
import argparse
import sys
from dataclasses import dataclass

import numpy as np
import soundfile as sf
from numpy.lib.stride_tricks import sliding_window_view

HOP_MS = 10


def to_db(p):
    return 10 * np.log10(np.maximum(p, 1e-20))


def moving_avg(x, n):
    c = np.concatenate(([0.0], np.cumsum(x, dtype=np.float64)))
    i = np.arange(len(x))
    lo = np.clip(i - n // 2, 0, len(x))
    hi = np.clip(i - n // 2 + n, 0, len(x))
    return (c[hi] - c[lo]) / np.maximum(hi - lo, 1)


def moving_max(x, n):
    h = n // 2
    return sliding_window_view(np.pad(x, (h, n - 1 - h), mode="edge"), n).max(axis=1)


def hms(s):
    s = int(round(s))
    return f"{s // 3600:d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def to_sec(t):
    sec = 0.0
    for part in t.strip().split(":"):
        sec = sec * 60 + float(part)
    return sec


def runs(mask):
    d = np.diff(np.concatenate(([0], mask.astype(np.int8), [0])))
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def measure(path, hop):
    powers, peaks = [], []
    for b in sf.blocks(path, blocksize=hop * 3000, dtype="float32", always_2d=True):
        r = len(b) % hop
        if r:
            b = np.pad(b, ((0, hop - r), (0, 0)))
        f = b.reshape(-1, hop, b.shape[1])
        powers.append(np.mean(f.astype(np.float64) ** 2, axis=(1, 2)))
        peaks.append(np.max(np.abs(f), axis=(1, 2)))
    return np.concatenate(powers), np.concatenate(peaks)


def make_parser():
    ap = argparse.ArgumentParser(description="Raise only long quiet stretches of speech.")
    ap.add_argument("input")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--analyze", action="store_true", help="report only")
    ap.add_argument("--window", type=float, default=10.0, help="seconds used to judge a stretch's level")
    ap.add_argument("--quiet-low", type=float, default=16.0, help="max dB below typical speech that still counts as quiet speech")
    ap.add_argument("--quiet-high", type=float, default=6.0, help="min dB below typical speech to count as quiet")
    ap.add_argument("--floor", type=float, default=None, help="stretches below this dB are treated as debleed, never raised")
    ap.add_argument("--contrast", type=float, default=15.0, help="real speech must be this many dB above its own gaps")
    ap.add_argument("--skip", action="append", default=[], metavar="START-END",
                    help="never raise this time range, e.g. --skip 1:15:00-1:15:25 (repeatable)")
    ap.add_argument("--original", metavar="ORIGINAL.wav",
                    help="the same recording BEFORE debleed; only parts debleed left alone (main speaker) get raised")
    ap.add_argument("--removed", type=float, default=6.0,
                    help="with --original: if debleed took away more than this many dB, that moment is bleed, never raised")
    ap.add_argument("--other", metavar="OTHER_MIC.wav",
                    help="the OTHER person's mic (same take). Moments where they are the one talking are never raised")
    ap.add_argument("--min-len", type=float, default=8.0, help="quiet stretch must last this long (s)")
    ap.add_argument("--max-gain", type=float, default=12.0, help="never raise more than this (dB)")
    ap.add_argument("--gate", type=float, default=15.0, help="words = within this many dB of the stretch's speech level")
    ap.add_argument("--word-floor", type=float, default=12.0,
                    help="words must also be this many dB above the stretch's gaps, so debleed residue isn't raised")
    ap.add_argument("--ceiling", type=float, default=-6.3, help="raised peaks stay below this (dBFS)")
    ap.add_argument("--release", type=float, default=80.0, help="limiter release on raised words (ms)")
    return ap


@dataclass
class Stretch:
    s: int  # start / end in 0.5 s analysis steps
    e: int
    speech: float
    gaps: float
    gain: float

    @property
    def start(self):
        return self.s / 2

    @property
    def end(self):
        return self.e / 2


@dataclass
class Analysis:
    args: argparse.Namespace
    info: object
    sr: int
    hop: int
    hps: int
    idx: np.ndarray       # hop index of each 0.5 s analysis step
    sec: np.ndarray       # speech level per step
    floor: np.ndarray     # gap level per step
    keep: np.ndarray      # step is inside a quiet stretch
    g_sec: np.ndarray     # wanted gain per step
    L: np.ndarray         # 50 ms level per hop
    own: np.ndarray
    mine: object
    act: object
    peak: np.ndarray
    lo: float
    ref: float
    stretches: list


def analyze(args, log=print):
    info = sf.info(args.input)
    sr = info.samplerate
    hop = int(sr * HOP_MS / 1000)
    hps = 1000 // HOP_MS
    log(f"Reading {args.input}  ({hms(info.duration)}, {sr} Hz, {info.channels} ch, {info.subtype})")
    power, peak = measure(args.input, hop)
    n = len(power)

    L = to_db(moving_avg(power, 5))  # 50 ms level per 10 ms hop

    own = np.ones(n, dtype=bool)  # True = main speaker (debleed left it alone)
    mine = act = None
    if args.original:
        oinfo = sf.info(args.original)
        if oinfo.samplerate != sr:
            raise ValueError(f"--original is {oinfo.samplerate} Hz but input is {sr} Hz; they must match.")
        if abs(oinfo.frames - info.frames) > sr // 10:
            log(f"WARNING: original and debleed lengths differ ({hms(oinfo.duration)} vs {hms(info.duration)}). "
                f"They must be the same take and line up from the start.")
        log(f"Reading original {args.original}")
        opower, _ = measure(args.original, hop)
        opower = np.pad(opower[:n], (0, max(0, n - len(opower))))
        Lo = to_db(moving_avg(opower, 5))
        removed = Lo - L
        own = removed < args.removed

    step, win = hps // 2, int(args.window * hps)
    idx = np.arange(0, n, step)
    if args.other:
        xinfo = sf.info(args.other)
        if xinfo.samplerate != sr:
            raise ValueError(f"--other is {xinfo.samplerate} Hz but input is {sr} Hz; they must match.")
        log(f"Reading other mic {args.other}")
        xpower, _ = measure(args.other, hop)
        xpower = np.pad(xpower[:n], (0, max(0, n - len(xpower))))
        Lx = to_db(moving_avg(xpower, 5))
        L1 = Lo if args.original else L
        D = L1 - Lx  # >0: this mic louder than the other one
        act = (L1 > np.percentile(L1, 10) + 12) | (Lx > np.percentile(Lx, 10) + 12)
        d = D[act]
        c1, c2 = np.percentile(d, 20), np.percentile(d, 80)
        for _ in range(20):  # 2-cluster split: "me talking" vs "them talking"
            mid = (c1 + c2) / 2
            c1, c2 = d[d <= mid].mean(), d[d > mid].mean()
        mid = (c1 + c2) / 2
        mine = D > mid
        own &= mine
        log(f"Speaker check: your mic is {c2:+.1f} dB vs theirs when you talk, {c1:+.1f} dB when they talk "
            f"(split at {mid:+.1f} dB). They talk {100 * (act & ~mine).sum() / max(act.sum(), 1):.0f}% of the active time.")

    Lown = np.where(own, L, -200.0)  # bleed moments don't count toward a stretch's speech level
    pc = np.array([(np.percentile(L[max(0, c - win // 2):c + win // 2], 10),
                    np.percentile(Lown[max(0, c - win // 2):c + win // 2], 90)) for c in idx])
    floor_lvl, sec = pc[:, 0], pc[:, 1]

    active = sec > np.percentile(sec, 95) - 30
    ref = float(np.median(sec[active]))
    lo, hi = ref - args.quiet_low, ref - args.quiet_high
    if args.original:
        loud = L > ref - 10
        log(f"Main speaker = {100 * own.mean():.0f}% of the file, debleed/bleed = {100 * (1 - own.mean()):.0f}%"
            f"  (on normal speech debleed removed {np.median(removed[loud & own]):.1f} dB on average - should be near 0)")
    log(f"Typical speech level: {ref:.1f} dB -> quiet = {lo:.1f} .. {hi:.1f} dB for >= {args.min_len:g} s")

    # real talking = words well above the gaps between them; debleed residue
    # (with maybe a stray word) is flat, so its contrast is small
    talking = (sec - floor_lvl) >= args.contrast
    talking = moving_avg(talking.astype(float), 9) > 0.6  # must hold over ~4 s, not one word
    if args.original:  # enough of the stretch must be the main speaker actually talking
        lvl_hop = np.interp(np.arange(n), idx, sec)
        spk = (own & (L > lvl_hop - args.gate)).astype(float)
        talking &= np.array([spk[max(0, c - win // 2):c + win // 2].mean() for c in idx]) >= 0.10
    quiet = (sec >= lo) & (sec <= hi) & talking
    if args.floor is not None:
        quiet &= sec >= args.floor
    for rng_txt in args.skip:
        a, b = (to_sec(t) for t in rng_txt.split("-"))
        quiet[(idx / hps >= a - args.window / 2) & (idx / hps <= b + args.window / 2)] = False
    keep = np.zeros_like(quiet)
    for s, e in runs(quiet):
        if e - s >= int(args.min_len * 2):
            keep[s:e] = True

    g_sec = np.where(keep, np.clip(ref - sec, 0, args.max_gain), 0.0)
    g_sec = np.where(keep, moving_avg(g_sec, 9), 0.0)

    stretches = [Stretch(int(s), int(e), float(np.median(sec[s:e])), float(np.median(floor_lvl[s:e])),
                         float(g_sec[s:e].max())) for s, e in runs(keep)]
    return Analysis(args, info, sr, hop, hps, idx, sec, floor_lvl, keep, g_sec, L, own, mine, act, peak, lo, ref, stretches)


def gain_curve(a, skipped=()):
    """Final gain (dB) per 10 ms hop. `skipped` = indexes into a.stretches that must not be raised."""
    args, n = a.args, len(a.L)
    keep, g_sec = a.keep.copy(), a.g_sec.copy()
    for i in skipped:
        st = a.stretches[i]
        keep[st.s:st.e] = False
        g_sec[st.s:st.e] = 0.0

    hop_i = np.arange(n)
    gain = np.interp(hop_i, a.idx, g_sec)
    in_stretch = np.interp(hop_i, a.idx, keep.astype(float)) > 0.5
    lvl = np.interp(hop_i, a.idx, a.sec)
    gaps = np.interp(hop_i, a.idx, a.floor)
    words = in_stretch & (a.L > lvl - args.gate) & (a.L > a.lo - args.gate) & a.own
    words &= a.L > gaps + args.word_floor  # debleed residue sits near the gap level: keep it out
    gate = moving_max(words.astype(float), 11)  # open 50 ms before / hold 50 ms after a word
    if args.other:
        gate *= ~moving_max((~a.mine & a.act).astype(float), 5).astype(bool)  # never hold into the other person's talking
    gate = moving_avg(gate, 5)                   # 50 ms ramps, no clicks
    gain = gain * gate * in_stretch

    peak_db = 20 * np.log10(np.maximum(a.peak, 1e-10))
    red = np.minimum(0.0, args.ceiling - (moving_max(peak_db, 3) + gain))
    red = -moving_max(-red, 3)
    rel = np.exp(-HOP_MS / max(args.release, 1.0))
    sm = np.empty_like(red)
    cur = 0.0
    for i, r in enumerate(red):
        cur = r if r < cur else r + (cur - r) * rel
        sm[i] = cur
    gain = np.clip(gain + np.where(gain > 0, sm, 0.0), 0, None)
    gain[gain < 0.05] = 0.0
    return gain


def render(a, output, gain, start=None, end=None, apply_gain=True):
    """Write the input with `gain` applied. start / end (seconds) write just that part (for previews)."""
    sr, hop, info = a.sr, a.hop, a.info
    first = 0 if start is None else max(0, int(start * sr))
    last = info.frames if end is None else min(info.frames, int(end * sr))
    centers = (np.arange(len(gain)) + 0.5) * hop
    ceil_lin = 10 ** (a.args.ceiling / 20)
    pos = first
    with sf.SoundFile(output, "w", samplerate=sr, channels=info.channels,
                      subtype=info.subtype, format=info.format) as out:
        for b in sf.blocks(a.args.input, blocksize=hop * 3000, dtype="float32", always_2d=True,
                           start=first, stop=last):
            m = len(b)
            g = np.interp(np.arange(pos, pos + m), centers, gain)
            y = b.copy()
            on = g > 0
            if apply_gain and on.any():
                y[on] = b[on] * (10 ** (g[on] / 20)).astype(np.float32)[:, None]
                lim = np.maximum(ceil_lin, np.abs(b))  # never push a sample past the ceiling (or past itself if already over)
                over = on[:, None] & (np.abs(y) > lim)
                y[over] = np.sign(y[over]) * lim[over]
            out.write(y)
            pos += m


def main():
    ap = make_parser()
    args = ap.parse_args()
    if not args.analyze and not args.output:
        ap.error("give an output file, or use --analyze")

    try:
        a = analyze(args)
    except ValueError as e:
        sys.exit(str(e))

    print("\nQuiet stretches found (only these get raised):")
    if not a.stretches:
        print("  none")
    for st in a.stretches:
        print(f"  {hms(st.start)} - {hms(st.end)}  speech {st.speech:6.1f} dB, gaps {st.gaps:6.1f} dB"
              f"  ->  up to +{st.gain:.1f} dB on words")
    if args.analyze:
        return

    render(a, args.output, gain_curve(a))
    print(f"\nWrote {args.output}  (everything outside the stretches above is unchanged)")


if __name__ == "__main__":
    sys.exit(main())
