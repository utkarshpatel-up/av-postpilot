"""
Feedback detection + spectral-heal (notch) engine.

Copied from the Feedback Cutter project (backend/dsp.py); only the
SUBPROCESS_OPTIONS import was inlined so it runs without that package.

Pipeline:
  1. Load audio (any format via ffmpeg fallback), mix to mono for detection.
  2. Streaming/overlap-save STFT so memory stays bounded on long recordings.
  3. Detect feedback = narrow-band peaks that stand well above the local
     spectral envelope AND persist across many consecutive frames.
  4. Notch each event: attenuate the offending bins toward the surrounding
     spectral envelope, with smooth ramps in time + frequency (no clicks).
  5. Render before/after display spectrograms and export marker files.
"""

import os
import shutil
import tempfile
import subprocess
import concurrent.futures
from collections import deque

# no console window flashing up for each ffmpeg call on Windows
SUBPROCESS_OPTIONS = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
from dataclasses import dataclass, asdict

import threading

import numpy as np
import soundfile as sf
from scipy.signal import stft, istft, get_window
from scipy.ndimage import median_filter

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def _find_ffmpeg():
    """Locate ffmpeg by absolute path. Launched from the macOS dock, the app gets
    a minimal PATH that omits /opt/homebrew/bin, so relying on PATH alone fails."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"):
        if os.path.exists(p):
            return p
    # pip wheels include FFmpeg for Windows/macOS/Linux; no PATH setup needed.
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        return "ffmpeg"


FFMPEG = _find_ffmpeg()
from matplotlib.patches import Rectangle


DEFAULTS = dict(
    n_fft=4096,
    hop=1024,
    prom_db=14.0,        # candidate gate: peak must beat local envelope by this (dB)
    min_prom_db=22.0,    # sensitivity: only surface candidates this far above floor
    env_med_bins=101,    # freq-width of median filter used as the "background" envelope
    min_dur_ms=250.0,    # a fragment must sustain at least this long to count
    max_dur_s=600.0,     # safety cap only; drones are rejected by harmonics, not length
    harm_prom_db=12.0,   # an overtone must clear this floor to count at all
    harm_rel_db=15.0,    # ...AND sit within this of the fundamental. A real note's
                         # harmonics rival its fundamental; feedback is a lone tone
                         # far above any stray energy at a multiple, so a 46 dB howl
                         # with 14 dB at 2x is NOT a note and must not be rejected.
    gap_ms=200.0,        # tolerate dropouts inside one sustained tone
    # Consolidate fragments of one ring. Tolerance is freq-proportional so a
    # drifting high ring stays together, while a low steady line does NOT merge
    # with the moving voice formants around it (that merge was ruining the lows).
    cluster_hz=35.0,     # minimum merge tolerance (Hz)
    cluster_frac=0.06,   # ...plus this fraction of the frequency
    bridge_s=6.0,        # bridge time gaps up to here (a ring masked by program)
    # Auto-cut requires BOTH: frequency stability (spread/freq small — a fixed line,
    # not wandering voice) AND being above the voice band. Below ~1 kHz, a stable
    # line is ambiguous (feedback vs a steady voice/drone harmonic), so those are
    # surfaced for review — visible on the log display, tickable by ear — but not
    # auto-cut, since cutting voice-band content risks the voice.
    auto_min_freq=1000.0,
    max_rel_spread=0.18,
    min_freq=150.0,      # ignore low rumble / stage thumps
    max_freq=None,       # default: min(nyquist, 12 kHz)
    notch_bw_hz=20.0,    # half-width of the deep core notch around the tracked freq
    max_atten_db=48.0,   # depth of the notch — deep enough the ring is inaudible
    track_pad_hz=45.0,   # search this far beyond the finding band for the live peak
    track_mode_frac=0.06,  # a bin is a feedback line if it's the peak this often
    ramp_ms=30.0,        # time-domain fade in/out of each notch
)


@dataclass
class Event:
    t_start: float       # seconds
    t_end: float         # seconds
    freq: float          # Hz
    prom_db: float       # how far above the local envelope (dB)
    active: float = -1.0  # cumulative time the tone was ringing (>= span for lines)
    freq_lo: float = -1.0  # low/high edge of the frequency the tone wandered over
    freq_hi: float = -1.0
    manual: bool = False   # user-drawn region: notch its exact band, no auto-tracking

    def __post_init__(self):
        if self.active < 0:
            self.active = self.t_end - self.t_start
        if self.freq_lo < 0:
            self.freq_lo = self.freq
        if self.freq_hi < 0:
            self.freq_hi = self.freq

    @property
    def duration(self):
        return self.t_end - self.t_start

    @property
    def score(self):
        # feedback reads as a tone that is prominent AND persists at a fixed
        # frequency. Weight prominence and cumulative ring-time together, so a
        # faint-but-sustained ring outranks a loud, fleeting sung note.
        prom = np.clip((self.prom_db - 12) / 26, 0, 1)
        persist = np.clip(self.active / 3.0, 0, 1)
        return int(np.clip((0.5 * prom + 0.5 * persist) * 100, 0, 100))

    @property
    def severity(self):
        s = self.score
        return "High" if s >= 62 else "Med" if s >= 38 else "Low"

    def to_dict(self):
        d = asdict(self)
        d.update(duration=round(self.duration, 3), active=round(self.active, 3),
                 severity=self.severity, score=self.score,
                 t_start=round(self.t_start, 3), t_end=round(self.t_end, 3),
                 freq=round(self.freq, 1), prom_db=round(self.prom_db, 1))
        return d


# --------------------------------------------------------------------------- IO

def load_audio(path):
    """Return (x[N,ch] float32, sr). Uses ffmpeg as a universal fallback."""
    try:
        x, sr = sf.read(path, always_2d=True, dtype="float32")
        if x.size:
            return x, sr
    except Exception:
        pass
    tmp = tempfile.mktemp(suffix=".wav")
    try:
        subprocess.run(
            [FFMPEG, "-y", "-i", path, "-c:a", "pcm_f32le", tmp],
            check=True, capture_output=True, **SUBPROCESS_OPTIONS,
        )
        x, sr = sf.read(tmp, always_2d=True, dtype="float32")
        return x, sr
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _win(p):
    return get_window("hann", p["n_fft"], fftbins=True)


def _stft(x, sr, p):
    return stft(x, fs=sr, window=_win(p), nperseg=p["n_fft"],
                noverlap=p["n_fft"] - p["hop"])


# -------------------------------------------------------------------- detection

def _runs_with_gap(idx, gap):
    """Group sorted frame indices into runs, bridging gaps <= `gap` frames."""
    if idx.size == 0:
        return []
    splits = np.where(np.diff(idx) > gap + 1)[0]
    return [(g[0], g[-1]) for g in np.split(idx, splits + 1)]


# The frequency-envelope median is the single biggest cost of a detection pass.
# Its kernel is one frame wide in time, so every time-column is independent and
# the array can be split across cores for a bit-identical result. scipy's C
# filter releases the GIL, so threads (not processes) parallelise it with no
# copying. The budget is set per task by the chunk scheduler (see `_map_ordered`)
# so a single-chunk import uses every core here while a many-chunk import — whose
# chunks already fill the machine — runs it single-threaded.
_INNER = threading.local()


def _inner_workers():
    return getattr(_INNER, "n", 1)


def _median_env(magdb, size):
    """median_filter(magdb, size, mode='nearest'), split over time-columns across
    `_inner_workers()` threads. Identical output — the kernel spans no columns."""
    w = _inner_workers()
    cols = magdb.shape[1]
    if w <= 1 or cols < 2 * w:
        return median_filter(magdb, size=size, mode="nearest")
    edges = np.linspace(0, cols, w + 1).astype(int)
    parts = [None] * w

    def work(i):
        parts[i] = median_filter(magdb[:, edges[i]:edges[i + 1]], size=size, mode="nearest")

    with concurrent.futures.ThreadPoolExecutor(max_workers=w) as ex:
        list(ex.map(work, range(w)))
    return np.concatenate(parts, axis=1)


def detect_in_array(mono, sr, p, t_offset=0.0):
    f, t, Z = _stft(mono, sr, p)
    mag = np.abs(Z)
    magdb = 20 * np.log10(mag + 1e-9)
    env = _median_env(magdb, (p["env_med_bins"], 1))
    prom = magdb - env

    nyq = sr / 2
    maxf = p["max_freq"] or min(nyq, 12000.0)
    fmask = (f >= p["min_freq"]) & (f <= maxf)

    # local maxima along frequency (a real tone is a ridge, not a shoulder)
    lm = np.zeros_like(mag, dtype=bool)
    lm[1:-1, :] = (mag[1:-1, :] >= mag[:-2, :]) & (mag[1:-1, :] >= mag[2:, :])
    cand = (prom > p["prom_db"]) & lm & fmask[:, None]

    frame_dt = (t[1] - t[0]) if len(t) > 1 else p["hop"] / sr
    min_frames = max(1, int(round(p["min_dur_ms"] / 1000 / frame_dt)))
    gap_frames = int(round(p["gap_ms"] / 1000 / frame_dt))

    raw = []  # (bin, start_frame, end_frame, max_prom)
    active_bins = np.flatnonzero(cand.any(axis=1))
    for b in active_bins:
        for s, e in _runs_with_gap(np.flatnonzero(cand[b]), gap_frames):
            if e - s + 1 >= min_frames:
                raw.append((b, s, e, float(prom[b, s:e + 1].max())))

    # merge events that overlap in time and sit within 2 freq bins of each other
    raw.sort(key=lambda r: (r[1], r[0]))
    merged = []
    for b, s, e, pr in raw:
        hit = None
        for m in merged:
            if abs(m["b"] - b) <= 2 and not (e < m["s"] - gap_frames or s > m["e"] + gap_frames):
                hit = m
                break
        if hit:
            hit["s"] = min(hit["s"], s)
            hit["e"] = max(hit["e"], e)
            if pr > hit["pr"]:
                hit["pr"], hit["b"] = pr, b
        else:
            merged.append(dict(b=b, s=s, e=e, pr=pr))

    def partner_prom(fp, s, e):
        """Max prominence near frequency fp during frames [s,e] (±1 bin)."""
        if fp < f[0] or fp > f[-1]:
            return -np.inf
        bp = int(np.argmin(np.abs(f - fp)))
        return float(prom[max(0, bp - 1):bp + 2, s:e + 1].max())

    events = []
    for m in merged:
        f0 = f[m["b"]]
        # feedback is a lone sinusoid; a musical note is the root of a harmonic
        # series. Treat this as a note only when an overtone both clears the floor
        # AND rivals the fundamental (within harm_rel_db) — a genuine series. A
        # lone howl 30+ dB above incidental energy at 2x/3x/4x stays feedback.
        harmonic = max(partner_prom(2 * f0, m["s"], m["e"]),
                       partner_prom(3 * f0, m["s"], m["e"]),
                       partner_prom(4 * f0, m["s"], m["e"]))
        if harmonic > p["harm_prom_db"] and harmonic >= m["pr"] - p["harm_rel_db"]:
            continue
        events.append(Event(t_start=float(t[m["s"]]) + t_offset,
                            t_end=float(t[m["e"]]) + t_offset,
                            freq=float(f[m["b"]]), prom_db=m["pr"]))
    # safety cap only (drones are already rejected above by their harmonics)
    events = [ev for ev in events if ev.duration <= p["max_dur_s"]]
    return events


def merge_events(events, freq_tol_hz=30.0, time_gap_s=0.08):
    """Fold together near-duplicate events (e.g. across chunk boundaries)."""
    events = sorted(events, key=lambda e: e.t_start)
    out = []
    for ev in events:
        hit = None
        for m in out:
            if abs(m.freq - ev.freq) <= freq_tol_hz and \
               not (ev.t_end < m.t_start - time_gap_s or ev.t_start > m.t_end + time_gap_s):
                hit = m
                break
        if hit:
            hit.t_start = min(hit.t_start, ev.t_start)
            hit.t_end = max(hit.t_end, ev.t_end)
            hit.prom_db = max(hit.prom_db, ev.prom_db)
        else:
            out.append(ev)
    return out


def consolidate_events(events, freq_tol_hz=50.0, freq_tol_frac=0.0, bridge_s=2.0):
    """Group a stable-frequency tone that recurs over time into one finding.

    A persistent ring is masked on and off by program material, so it shows up
    as many short fragments at ~one frequency. This stitches them into a single
    event spanning first..last, tracking cumulative ring-time in `active`. The
    merge tolerance is freq-proportional so a drifting high ring stays together
    while a low steady line stays separate from nearby (moving) voice formants.
    """
    events = sorted(events, key=lambda e: e.t_start)
    clusters = []  # each: representative Event with running freq mean + count
    for ev in events:
        hit = None
        for c in clusters:
            tol = max(freq_tol_hz, c["freq"] * freq_tol_frac)
            if abs(c["freq"] - ev.freq) <= tol and ev.t_start <= c["t_end"] + bridge_s:
                hit = c
                break
        if hit:
            hit["t_end"] = max(hit["t_end"], ev.t_end)
            hit["active"] += ev.duration
            hit["prom_db"] = max(hit["prom_db"], ev.prom_db)
            hit["freq"] = (hit["freq"] * hit["n"] + ev.freq) / (hit["n"] + 1)
            hit["flo"] = min(hit["flo"], ev.freq)
            hit["fhi"] = max(hit["fhi"], ev.freq)
            hit["n"] += 1
        else:
            clusters.append(dict(freq=ev.freq, t_start=ev.t_start, t_end=ev.t_end,
                                 active=ev.duration, prom_db=ev.prom_db,
                                 flo=ev.freq, fhi=ev.freq, n=1))
    return [Event(t_start=c["t_start"], t_end=c["t_end"], freq=c["freq"],
                  prom_db=c["prom_db"], active=c["active"],
                  freq_lo=c["flo"], freq_hi=c["fhi"]) for c in clusters]


# ----------------------------------------------------------------------- notch

def notch_segment(x, sr, events, p):
    """Deep, frequency-tracking notch: for every frame of an event, find the exact
    feedback bin (it drifts) and cut it and its main lobe down to near silence.
    Narrow in frequency (music is untouched) but deep in level (the ring is gone)."""
    n, ch = x.shape
    out = np.zeros_like(x)
    df = None
    deep = 10 ** (-p["max_atten_db"] / 20)            # target level of the notch (deep)
    ramp = p["ramp_ms"] / 1000
    for c in range(ch):
        f, t, Z = _stft(x[:, c], sr, p)
        if df is None:
            df = f[1] - f[0]
            core = max(1, int(round(p["notch_bw_hz"] / df)))   # bins fully removed
            shoulder = max(1, int(round(core * 0.75)))          # cosine roll-off bins
            pad = int(round(p["track_pad_hz"] / df))            # freq search margin
            # frequency weight for a notch centred on a bin: 1 across core, cosine out
            offs = np.arange(-(core + shoulder), core + shoulder + 1)
            fwin = np.ones_like(offs, dtype=float)
            sh = np.abs(offs) > core
            fwin[sh] = 0.5 * (1 + np.cos(np.pi * (np.abs(offs[sh]) - core) / shoulder))
        mag = np.abs(Z)
        gain = np.ones_like(mag)
        nb = len(f)
        for ev in events:
            fi = np.where((t >= ev.t_start - ramp) & (t <= ev.t_end + ramp))[0]
            fbw = np.zeros(nb)
            if ev.manual:
                # user drew this box: notch EXACTLY the band they selected — no
                # auto-widening, so a pixel-perfect draw stays pixel-perfect. The
                # floor is one FFT bin (the finest the transform can resolve).
                lo_b = max(0, np.searchsorted(f, ev.freq_lo))
                hi_b = max(lo_b + 1, min(nb, np.searchsorted(f, ev.freq_hi)))
                if fi.size == 0:
                    continue
                fbw[lo_b:hi_b] = 1.0
                if lo_b - 1 >= 0:            # single-bin soft edge (avoid clicks), no widening
                    fbw[lo_b - 1] = max(fbw[lo_b - 1], 0.5)
                if hi_b < nb:
                    fbw[hi_b] = max(fbw[hi_b], 0.5)
            else:
                lo_b = max(0, np.searchsorted(f, ev.freq_lo) - pad)
                hi_b = min(nb, np.searchsorted(f, ev.freq_hi) + pad + 1)
                if fi.size == 0 or hi_b <= lo_b:
                    continue
                # which bins host the persistent tone: the argmax bin per frame, then
                # keep the ones that are the peak often enough (the feedback line(s)).
                # Robust to singing, which peaks at scattered, ever-changing bins.
                peaks = lo_b + np.argmax(mag[lo_b:hi_b, fi], axis=0)
                counts = np.bincount(peaks - lo_b, minlength=hi_b - lo_b)
                frac = counts / fi.size
                fb = [lo_b + i for i, fr in enumerate(frac) if fr >= p["track_mode_frac"]]
                if not fb:
                    fb = [lo_b + int(np.argmax(counts))]
                # build a narrow frequency weight covering those bins (deep core + shoulder)
                for k in fb:
                    a, b = k + offs[0], k + offs[-1] + 1
                    lo_i, hi_i = max(0, a), min(nb, b)
                    fbw[lo_i:hi_i] = np.maximum(fbw[lo_i:hi_i],
                                                fwin[lo_i - a: len(fwin) - (b - hi_i)])
            tw = np.clip((t[fi] - (ev.t_start - ramp)) / ramp, 0, 1)
            tw = np.minimum(tw, np.clip(((ev.t_end + ramp) - t[fi]) / ramp, 0, 1))
            block = 1 - np.outer(fbw, tw) * (1 - deep)
            gain[:, fi] = np.minimum(gain[:, fi], block)
        _, xr = istft(Z * gain, fs=sr, window=_win(p),
                      nperseg=p["n_fft"], noverlap=p["n_fft"] - p["hop"])
        xr = xr[:n]
        if xr.shape[0] < n:
            xr = np.pad(xr, (0, n - xr.shape[0]))
        out[:, c] = xr
    return out


# --------------------------------------------------------------- display spectro

def _coarse_cols(mono, sr, t0, cols_per_s, nfft=2048):
    """Compute widely-spaced spectrogram columns for a mono block (overview only).

    Uses a hop >= nfft so the column count stays tiny even for multi-hour files —
    this is what makes the display scale. Returns (list-of-dB-columns, times)."""
    win = get_window("hann", nfft, True)
    hop = max(nfft, int(round(sr / max(cols_per_s, 1e-6))))
    cols, times = [], []
    for s in range(0, max(1, len(mono) - nfft + 1), hop):
        seg = mono[s:s + nfft]
        if len(seg) < nfft:
            break
        cols.append(20 * np.log10(np.abs(np.fft.rfft(seg * win)) + 1e-9))
        times.append(t0 + (s + nfft / 2) / sr)
    return cols, times


DISP_FMIN = 120.0     # log-freq display floor (below speech fundamentals)
DISP_MAX_COLS = 2400  # cap columns drawn: the PNG is ~1800px wide, so more than
                      # this can't be seen, and pcolormesh cost is linear in them


def _max_spec_cols():
    """Column cap, overridable via FEEDBACK_CUTTER_MAX_SPEC_COLS for A/B testing
    render quality (set it huge to draw every column, small to exaggerate pooling)."""
    try:
        v = int(os.environ.get("FEEDBACK_CUTTER_MAX_SPEC_COLS", ""))
        return v if v > 0 else DISP_MAX_COLS
    except ValueError:
        return DISP_MAX_COLS


def _pool_cols(S, t, cap=None):
    """Shrink a wide spectrogram to at most `cap` time-columns by max-pooling
    adjacent columns. The image is only ~1800px wide, so drawing 28k columns for
    a 2-hour file is invisible work; max (not mean) keeps a brief ring's bright
    line from being averaged away. Files at or under the cap are returned as-is,
    so short/medium recordings render exactly as before."""
    cap = cap or _max_spec_cols()
    n = S.shape[1]
    if n <= cap:
        return S, t
    starts = np.linspace(0, n, cap + 1).astype(int)[:-1]
    counts = np.diff(np.append(starts, n))
    Sp = np.maximum.reduceat(S, starts, axis=1)     # peak per group (rings survive)
    tp = np.add.reduceat(t, starts) / counts          # group-mean time
    return Sp, tp


def _render_spec(path, cols, times, f, fmax, dur, title, cap=None, bare=False):
    """Render accumulated columns to a PNG on a LOG frequency axis, so the lows
    (where feedback hides among the voice) get real vertical room instead of a
    4% sliver. Returns the plot-area rectangle + axis range so the browser can
    overlay boxes that line up exactly. `cap` bounds the drawn columns (the
    Pooled/Maximum toggle); None falls back to the env/default cap.

    `bare` renders JUST the data — no axis frame, ticks, labels or title — filling
    the whole image (geom x0=0,y0=0,w=1,h=1). The interactive spectrogram uses
    this so the browser can draw crisp axis labels that don't stretch when the
    image is zoomed (baked-in matplotlib labels smear on horizontal zoom)."""
    if not cols:
        cols, times = [np.full(len(f), -120.0)], [0.0]
    S = np.column_stack(cols)
    t = np.asarray(times)
    S, t = _pool_cols(S, t, cap)          # cap draw cost on long files (display only)
    fmin = DISP_FMIN
    fsel = (f >= fmin) & (f <= fmax)
    if bare:
        fig = plt.figure(figsize=(15, 8.5), dpi=120)
        ax = fig.add_axes([0, 0, 1, 1])   # data fills the frame edge-to-edge
        vmax = np.percentile(S[fsel], 99.5)
        ax.pcolormesh(t, f[fsel], S[fsel], shading="nearest",
                      cmap="magma", vmin=vmax - 72, vmax=vmax)
        ax.set_yscale("log")
        ax.set_xlim(0, dur)
        ax.set_ylim(fmin, fmax)
        ax.set_facecolor("#14161c")
        ax.axis("off")
        fig.savefig(path, facecolor="#14161c")
        plt.close(fig)
        return dict(x0=0.0, y0=0.0, w=1.0, h=1.0, fmin=fmin, ylog=True, bare=True)
    fig, ax = plt.subplots(figsize=(15, 8.5), dpi=120)
    vmax = np.percentile(S[fsel], 99.5)
    ax.pcolormesh(t, f[fsel], S[fsel], shading="nearest",
                  cmap="magma", vmin=vmax - 72, vmax=vmax)
    ax.set_yscale("log")
    ax.set_xlim(0, dur)
    ax.set_ylim(fmin, fmax)
    ax.set_xlabel("Time (s)", fontsize=15)
    ax.set_ylabel("Frequency (Hz)", fontsize=15)
    ax.set_title(title, color="#ddd", fontsize=15)
    from matplotlib.ticker import LogLocator, ScalarFormatter
    ax.yaxis.set_major_locator(LogLocator(base=10, subs=(1, 2, 5)))
    ax.yaxis.set_major_formatter(ScalarFormatter())
    fig.patch.set_facecolor("#14161c")
    ax.set_facecolor("#14161c")
    ax.tick_params(colors="#aaa", labelsize=13)
    for s in ax.spines.values():
        s.set_color("#333")
    ax.xaxis.label.set_color("#aaa")
    ax.yaxis.label.set_color("#aaa")
    fig.tight_layout()
    fig.canvas.draw()
    pos = ax.get_position()
    geom = dict(x0=float(pos.x0), y0=float(1 - pos.y1),
                w=float(pos.width), h=float(pos.height),
                fmin=fmin, ylog=True)
    fig.savefig(path, facecolor=fig.get_facecolor())
    plt.close(fig)
    return geom


# ------------------------------------------------------------------- marker export

def _fmt_time(s):
    h = int(s // 3600); m = int((s % 3600) // 60); sec = s % 60
    return f"{h}:{m:02d}:{sec:06.3f}"


def export_markers(path, events):
    """Adobe Audition 'Import Markers From File' compatible CSV."""
    import csv
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["Name", "Start", "Duration", "Time Format", "Type", "Description"])
        for i, ev in enumerate(events, 1):
            w.writerow([f"FB {i} ({int(round(ev.freq))}Hz)",
                        _fmt_time(ev.t_start), _fmt_time(ev.duration),
                        "decimal", "Cue",
                        f"{ev.severity} feedback, {ev.prom_db:.1f} dB above floor"])


def export_events_csv(path, events):
    import csv
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["#", "start_s", "end_s", "duration_s", "freq_hz",
                    "prominence_db", "severity", "score"])
        for i, ev in enumerate(events, 1):
            w.writerow([i, round(ev.t_start, 3), round(ev.t_end, 3),
                        round(ev.duration, 3), round(ev.freq, 1),
                        round(ev.prom_db, 1), ev.severity, ev.score])


# ------------------------------------------------------------------------ driver

def detect_all(mono, sr, p):
    """Run detection over the whole (mono) signal, chunked for long files."""
    N = len(mono)
    chunk = int(60 * sr)
    margin = int(2 * sr)
    if N <= chunk + 2 * margin:
        events = detect_in_array(mono, sr, p)
    else:
        events = []
        cs = 0
        while cs < N:
            ce = min(N, cs + chunk)
            rs, re = max(0, cs - margin), min(N, ce + margin)
            for ev in detect_in_array(mono[rs:re], sr, p, t_offset=rs / sr):
                mid = (ev.t_start + ev.t_end) / 2
                if cs / sr <= mid < ce / sr:
                    events.append(ev)
            cs = ce
    events = merge_events(events)
    events = consolidate_events(events, freq_tol_hz=p["cluster_hz"],
                                bridge_s=p["bridge_s"])
    events = [e for e in events if e.prom_db >= p["min_prom_db"]]
    events.sort(key=lambda e: e.t_start)
    return events


def notch_full(x, sr, events, p):
    """Notch a list of events out of x[N,ch], chunked for long files."""
    N = x.shape[0]
    chunk = int(60 * sr)
    margin = int(2 * sr)
    if not events:
        return x.copy()
    if N <= chunk + 2 * margin:
        return notch_segment(x, sr, events, p)
    cleaned = np.zeros_like(x)
    cs = 0
    while cs < N:
        ce = min(N, cs + chunk)
        rs, re = max(0, cs - margin), min(N, ce + margin)
        seg_events = [Event(ev.t_start - rs / sr, ev.t_end - rs / sr, ev.freq,
                            ev.prom_db, ev.active, ev.freq_lo, ev.freq_hi)
                      for ev in events if ev.t_end > rs / sr and ev.t_start < re / sr]
        seg = notch_segment(x[rs:re], sr, seg_events, p)
        cleaned[cs:ce] = seg[cs - rs: cs - rs + (ce - cs)]
        cs = ce
    return cleaned


def _auto_selected(ev, events, p):
    """Auto-tick only a strong, sustained, frequency-STABLE tone — a feedback line
    sits at a fixed pitch (narrow spread), whereas voice moves (wide spread). This
    catches low steady rings while leaving the wandering voice alone."""
    rel_spread = (ev.freq_hi - ev.freq_lo) / max(ev.freq, 1.0)
    return (ev.severity == "High"
            and ev.freq >= p["auto_min_freq"]
            and rel_spread <= p["max_rel_spread"])


# ---------------------------------------------------------------- streaming I/O

CHUNK_S = 60      # seconds of audio processed at a time (bounds memory)
MARGIN_S = 2      # overlap kept on each side, then discarded (overlap-save)
DISP_NFFT = 2048  # fft size for the overview spectrogram


def _ensure_wav(in_path, job_dir):
    """Return (path, is_temp). Random-access decoders (WAV/FLAC/AIFF) are used
    directly; anything else is transcoded once to a temp WAV so we can seek it."""
    try:
        info = sf.info(in_path)
        if info.format in ("WAV", "WAVEX", "W64", "FLAC", "AIFF", "AIFC"):
            return in_path, False
    except Exception:
        pass
    tmp = os.path.join(job_dir, "_decoded.wav")
    subprocess.run([FFMPEG, "-y", "-i", in_path, "-c:a", "pcm_f32le", tmp],
                   check=True, capture_output=True, **SUBPROCESS_OPTIONS)
    return tmp, True


def _chunks(N, sr):
    """Yield (core_start, core_end, read_start, read_end) sample ranges."""
    chunk, margin = int(CHUNK_S * sr), int(MARGIN_S * sr)
    cs = 0
    while cs < N:
        ce = min(N, cs + chunk)
        yield cs, ce, max(0, cs - margin), min(N, ce + margin)
        cs = ce


def _mp3(src, dst):
    """Small mono MP3 preview for the in-browser player (WAV stays for download)."""
    subprocess.run([FFMPEG, "-y", "-i", src, "-ac", "1", "-b:a", "64k", dst],
                   check=True, capture_output=True, **SUBPROCESS_OPTIONS)


# ---- parallelism: the per-chunk FFT passes are the slow part of an import, and
# each chunk is independent. numpy/scipy release the GIL inside the FFT and the
# median filter, so a thread pool spreads them across every core. Threads (not
# processes) keep it safe in the frozen Windows backend and avoid copying audio.
WORKERS = max(1, min(12, os.cpu_count() or 4))


def _map_ordered(fn, tasks, workers=WORKERS, window=None):
    """Run fn(*task) over tasks concurrently, yielding results in task order while
    keeping only ~`window` in flight so a multi-hour file stays within memory.

    Chunk-level parallelism only fills as many cores as there are chunks, so a
    short file (one chunk) or a few-minute file (a handful) leaves cores idle.
    We hand those spare cores to the per-chunk work that can use them (the
    envelope median): each task gets an inner-worker budget of cores/active-tasks,
    so a single-chunk import threads the median across every core while a
    many-chunk import — whose chunks already saturate the machine — runs it
    single-threaded. Results are numerically identical, just spread wider."""
    tasks = list(tasks)
    ncpu = os.cpu_count() or 4
    parallel = len(tasks) > 1 and workers > 1
    active = min(len(tasks), workers) if parallel else 1
    inner = max(1, ncpu // max(1, active))

    def run(args):
        # thread-local, so it applies in whichever thread runs the task (main
        # when serial, a pool thread when parallel).
        _INNER.n = inner
        try:
            return fn(*args)
        finally:
            _INNER.n = 1

    if not parallel:
        for a in tasks:
            yield run(a)
        return
    window = window or (workers + 2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs, i = deque(), 0
        while i < len(tasks) and len(futs) < window:
            futs.append(ex.submit(run, tasks[i])); i += 1
        while futs:
            r = futs.popleft().result()          # oldest task → results stay in order
            if i < len(tasks):
                futs.append(ex.submit(run, tasks[i])); i += 1
            yield r


# lossless subtypes we keep as-is so a 24/32-bit master is never dropped to 16-bit
_KEEP_SUBTYPES = {"FLOAT", "DOUBLE", "PCM_32", "PCM_24", "PCM_16", "PCM_U8",
                  "ALAW", "ULAW"}


def _out_subtype(wav_path):
    """Match the source bit depth so cleaned/original exports don't lose quality."""
    try:
        st = sf.info(wav_path).subtype
    except Exception:
        st = None
    return st if st in _KEEP_SUBTYPES else "FLOAT"


def _detect_chunk(wav_path, sr, cs, ce, rs, re, p, cols_per_s):
    """Detect feedback in one chunk (+ its overview columns). Runs on a worker."""
    with sf.SoundFile(wav_path) as snd:
        snd.seek(rs)
        data = snd.read(re - rs, dtype="float32", always_2d=True)
    mono = data.mean(1).astype("float32")
    evs = [ev for ev in detect_in_array(mono, sr, p, t_offset=rs / sr)
           if cs / sr <= (ev.t_start + ev.t_end) / 2 < ce / sr]
    core = mono[cs - rs: cs - rs + (ce - cs)]
    cc, tt = _coarse_cols(core, sr, cs / sr, cols_per_s, DISP_NFFT)
    return evs, cc, tt


def _notch_chunk(wav_path, sr, cs, ce, rs, re, selected, p, cols_per_s, want_original):
    """Notch one chunk and return (cleaned_core, removed_core, original_core, cols, times)."""
    with sf.SoundFile(wav_path) as snd:
        snd.seek(rs)
        data = snd.read(re - rs, dtype="float32", always_2d=True)
    seg = [Event(ev["t_start"] - rs / sr, ev["t_end"] - rs / sr, ev["freq"],
                 ev.get("prom_db", 30.0), freq_lo=ev.get("freq_lo", ev["freq"]),
                 freq_hi=ev.get("freq_hi", ev["freq"]), manual=ev.get("manual", False))
           for ev in selected
           if ev["t_end"] > rs / sr and ev["t_start"] < re / sr]
    seg_out = notch_segment(data, sr, seg, p) if seg else data
    o = data[cs - rs: cs - rs + (ce - cs)]
    c = seg_out[cs - rs: cs - rs + (ce - cs)]
    cc, tt = _coarse_cols(c.mean(1).astype("float32"), sr, cs / sr, cols_per_s, DISP_NFFT)
    return c, o - c, (o if want_original else None), cc, tt


def _stream_notch(wav_path, job_dir, sr, ch, N, dur, selected, p,
                  fdisp, fmax, cols_per_s, write_original, say, pct0, pctspan=30):
    """Notch `selected` out of wav_path chunk-by-chunk, writing cleaned/removed
    (and optionally original) WAVs incrementally. Returns after-spectrogram cols."""
    import contextlib
    acols, atimes = [], []
    subtype = _out_subtype(wav_path)                 # keep the source bit depth
    chunks = list(_chunks(N, sr))
    want_original = write_original
    tasks = [(wav_path, sr, cs, ce, rs, re, selected, p, cols_per_s, want_original)
             for cs, ce, rs, re in chunks]
    with contextlib.ExitStack() as st:
        wc = st.enter_context(sf.SoundFile(os.path.join(job_dir, "cleaned.wav"),
                              "w", samplerate=sr, channels=ch, subtype=subtype))
        wr = st.enter_context(sf.SoundFile(os.path.join(job_dir, "removed.wav"),
                              "w", samplerate=sr, channels=ch, subtype=subtype))
        wo = st.enter_context(sf.SoundFile(os.path.join(job_dir, "original.wav"),
                              "w", samplerate=sr, channels=ch, subtype=subtype)) \
            if write_original else None
        done = 0
        for c, rem, o, cc, tt in _map_ordered(_notch_chunk, tasks):
            wc.write(c)
            wr.write(rem)
            if wo is not None:
                wo.write(o)
            acols += cc
            atimes += tt
            done += 1
            if say:
                say(f"Removing feedback — chunk {done}/{len(tasks)}",
                    pct0 + int(pctspan * done / len(tasks)))
    return acols, atimes


def process(in_path, job_dir, params=None, progress=None):
    p = {**DEFAULTS, **(params or {})}
    os.makedirs(job_dir, exist_ok=True)

    def say(msg, pct):
        if progress:
            progress(msg, pct)

    say("Opening audio", 3)
    wav_path, is_tmp = _ensure_wav(in_path, job_dir)
    info = sf.info(wav_path)
    sr, ch, N = info.samplerate, info.channels, info.frames
    dur = N / sr
    fmax = min(sr / 2, 12000.0)
    fdisp = np.fft.rfftfreq(DISP_NFFT, 1 / sr)
    cols_per_s = min(40.0, max(4.0, 2400.0 / max(dur, 1)))  # overview density

    # ---- detection pass (parallel across cores) + before-spectrogram columns ----
    say("Scanning for feedback", 5)
    events, bcols, btimes = [], [], []
    dtasks = [(wav_path, sr, cs, ce, rs, re, p, cols_per_s)
              for cs, ce, rs, re in _chunks(N, sr)]
    done = 0
    for evs, cc, tt in _map_ordered(_detect_chunk, dtasks):
        events += evs
        bcols += cc
        btimes += tt
        done += 1
        say(f"Scanning for feedback — chunk {done}/{len(dtasks)}",
            5 + int(38 * done / len(dtasks)))

    events = merge_events(events)
    events = consolidate_events(events, freq_tol_hz=p["cluster_hz"],
                                freq_tol_frac=p.get("cluster_frac", 0.0),
                                bridge_s=p["bridge_s"])
    # Keep EVERY consolidated candidate (down to the detection gate) so the UI can
    # re-apply the sensitivity threshold live without re-running detection. The
    # chosen sensitivity only decides what's "detected" now and what we notch.
    candidates = sorted(events, key=lambda e: e.t_start)  # number by time: first ring = #1
    for i, ev in enumerate(candidates):
        ev.id = i
    sens = p["min_prom_db"]
    detected = [e for e in candidates if e.prom_db >= sens]
    selected = [ev for ev in detected if _auto_selected(ev, detected, p)]

    spec_cap = p.get("max_spec_cols")     # Pooled (default) vs Maximum toggle
    say("Rendering original spectrogram", 44)
    geom = _render_spec(os.path.join(job_dir, "spec_before.png"), bcols, btimes,
                        fdisp, fmax, dur, "Original — spectrogram", cap=spec_cap, bare=True)

    # ---- notch pass (streamed) ----
    say("Removing feedback", 46)
    sel_dicts = [dict(t_start=e.t_start, t_end=e.t_end, freq=e.freq,
                      prom_db=e.prom_db, freq_lo=e.freq_lo, freq_hi=e.freq_hi)
                 for e in selected]
    acols, atimes = _stream_notch(wav_path, job_dir, sr, ch, N, dur, sel_dicts, p,
                                  fdisp, fmax, cols_per_s, write_original=True,
                                  say=say, pct0=46, pctspan=32)
    say("Rendering cleaned spectrogram", 80)
    _render_spec(os.path.join(job_dir, "spec_after.png"), acols, atimes,
                 fdisp, fmax, dur, "Cleaned — feedback notched out", cap=spec_cap)

    prev = [(os.path.join(job_dir, b + ".wav"), os.path.join(job_dir, b + "_preview.mp3"))
            for b in ("original", "cleaned", "removed")]
    say("Encoding previews", 84)
    pdone = 0
    for _ in _map_ordered(_mp3, prev, workers=3):
        pdone += 1
        say(f"Encoding preview {pdone}/{len(prev)}", 84 + int(12 * pdone / len(prev)))
    say("Writing markers", 98)
    export_markers(os.path.join(job_dir, "markers_audition.csv"), selected)
    export_events_csv(os.path.join(job_dir, "events.csv"), detected)
    if is_tmp and os.path.exists(wav_path):
        os.remove(wav_path)

    say("Done", 100)
    ev_dicts = []
    for ev in candidates:
        d = ev.to_dict()
        d["id"] = ev.id
        d["selected"] = ev in selected
        d["auto"] = _auto_selected(ev, detected, p)  # would auto-tick if detected
        ev_dicts.append(d)
    return dict(
        sr=sr, channels=ch, duration=round(dur, 2),
        n_events=len(detected), n_selected=len(selected),
        n_candidates=len(candidates), sensitivity=sens,
        detect_floor=p["prom_db"],
        events=ev_dicts,
        spec=dict(fmax=fmax, duration=dur, **geom),
        params=dict(min_prom_db=p["min_prom_db"], notch_bw_hz=p["notch_bw_hz"],
                    max_atten_db=p["max_atten_db"]),
        files=dict(original="original.wav", cleaned="cleaned.wav", removed="removed.wav",
                   original_preview="original_preview.mp3",
                   cleaned_preview="cleaned_preview.mp3",
                   removed_preview="removed_preview.mp3",
                   spec_before="spec_before.png", spec_after="spec_after.png",
                   markers="markers_audition.csv", events_csv="events.csv"),
    )


def renotch(job_dir, selected_events, params=None):
    """Re-apply the notch for a user-chosen subset of events (streamed from
    original.wav), refreshing cleaned/removed audio, previews and after-spectrogram."""
    p = {**DEFAULTS, **(params or {})}
    wav_path = os.path.join(job_dir, "original.wav")
    info = sf.info(wav_path)
    sr, ch, N = info.samplerate, info.channels, info.frames
    dur = N / sr
    fmax = min(sr / 2, 12000.0)
    fdisp = np.fft.rfftfreq(DISP_NFFT, 1 / sr)
    cols_per_s = min(40.0, max(4.0, 2400.0 / max(dur, 1)))

    acols, atimes = _stream_notch(wav_path, job_dir, sr, ch, N, dur, selected_events, p,
                                  fdisp, fmax, cols_per_s, write_original=False,
                                  say=None, pct0=0)
    _render_spec(os.path.join(job_dir, "spec_after.png"), acols, atimes,
                 fdisp, fmax, dur, "Cleaned — feedback notched out",
                 cap=p.get("max_spec_cols"))
    list(_map_ordered(_mp3, [(os.path.join(job_dir, b + ".wav"),
                              os.path.join(job_dir, b + "_preview.mp3"))
                             for b in ("cleaned", "removed")], workers=2))
    marker_evs = [Event(t_start=e["t_start"], t_end=e["t_end"], freq=e["freq"],
                        prom_db=e.get("prom_db", 30.0)) for e in selected_events]
    export_markers(os.path.join(job_dir, "markers_audition.csv"), marker_evs)
    return dict(n_selected=len(selected_events))
