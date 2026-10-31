"""
Write / read range markers in a WAV file, in place, without touching the audio.

Markers are the standard RIFF ones: a 'cue ' chunk (positions) plus a LIST/adtl chunk with
'labl' (name) and 'ltxt' (length, purpose 'rgn ') per marker. Audition and RX read these.

Writing:
  - existing real markers are read first and written back alongside the new ones;
  - any existing 'cue ' / LIST-adtl chunks at the END of the file are cut off and replaced;
  - ones in the middle of the file are renamed to 'JUNK' (same size), so nothing has to move;
  - the new chunks are appended and the RIFF size is updated.
The audio data chunk is never rewritten. RF64 (> 4 GB) files are refused.
"""
import os
import struct


def _chunks(f, riff_end):
    """Yield (offset, id, size) for each top-level chunk."""
    pos = 12
    while pos + 8 <= riff_end:
        f.seek(pos)
        head = f.read(8)
        if len(head) < 8:
            break
        cid, size = head[:4], struct.unpack("<I", head[4:])[0]
        yield pos, cid, size
        pos += 8 + size + (size & 1)


def _is_marker_chunk(f, off, cid):
    if cid == b"cue ":
        return True
    if cid == b"LIST":
        f.seek(off + 8)
        return f.read(4) == b"adtl"
    return False


def _pad(b):
    return b + b"\0" if len(b) & 1 else b


def build_chunks(markers):
    """markers: list of (start_sample, length_samples, name)."""
    cue = struct.pack("<I", len(markers))
    adtl = b"adtl"
    for i, (start, length, name) in enumerate(markers, 1):
        cue += struct.pack("<II4sIII", i, start, b"data", 0, 0, start)
        text = name.encode("utf-8") + b"\0"
        adtl += b"labl" + struct.pack("<II", 4 + len(text), i) + _pad(text)
        adtl += b"ltxt" + struct.pack("<III4sHHHH", 20, i, max(0, length), b"rgn ", 0, 0, 0, 0)
    return b"cue " + struct.pack("<I", len(cue)) + cue + b"LIST" + struct.pack("<I", len(adtl)) + adtl


def write_markers(path, markers, prefix):
    """Set this tool's markers (names start with `prefix`). Other real markers in the file are kept;
    empty placeholder slots (position 0, no name - some recorders reserve 99 of them) are dropped."""
    keep = [m for m in read_markers(path) if (m[0] or m[2].strip()) and not m[2].startswith(prefix)]
    markers = sorted(keep + list(markers))
    with open(path, "r+b") as f:
        head = f.read(12)
        if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise ValueError(f"{os.path.basename(path)}: not a RIFF WAV file (RF64 / >4 GB files aren't supported).")
        file_end = f.seek(0, os.SEEK_END)
        riff_end = min(8 + struct.unpack("<I", head[4:8])[0], file_end)
        chunks = list(_chunks(f, riff_end))
        if not any(cid == b"data" for _, cid, _ in chunks):
            raise ValueError(f"{os.path.basename(path)}: no audio data chunk found.")

        # trailing marker chunks get cut; earlier ones get blanked to JUNK
        cut = riff_end
        for off, cid, _ in reversed(chunks):
            if not _is_marker_chunk(f, off, cid):
                break
            cut = off
        for off, cid, _ in chunks:
            if off < cut and _is_marker_chunk(f, off, cid):
                f.seek(off)
                f.write(b"JUNK")

        f.seek(cut)
        f.write(build_chunks(markers))
        f.truncate()
        new_end = f.tell()
        if new_end - 8 > 0xFFFFFFFF:
            raise ValueError("File would exceed the 4 GB WAV limit.")
        f.seek(4)
        f.write(struct.pack("<I", new_end - 8))


def read_markers(path):
    """[(start_sample, length_samples, name)] from cue + adtl, for checking what was written."""
    pos, names, lengths = {}, {}, {}
    with open(path, "rb") as f:
        head = f.read(12)
        riff_end = min(8 + struct.unpack("<I", head[4:8])[0], f.seek(0, os.SEEK_END))
        for off, cid, size in _chunks(f, riff_end):
            f.seek(off + 8)
            body = f.read(size)
            if cid == b"cue ":
                for k in range(struct.unpack("<I", body[:4])[0]):
                    cid_, start = struct.unpack("<II", body[4 + 24 * k:12 + 24 * k])
                    pos[cid_] = start
            elif cid == b"LIST" and body[:4] == b"adtl":
                p = 4
                while p + 8 <= len(body):
                    sid, ssz = body[p:p + 4], struct.unpack("<I", body[p + 4:p + 8])[0]
                    sub = body[p + 8:p + 8 + ssz]
                    mid = struct.unpack("<I", sub[:4])[0]
                    if sid == b"labl":
                        names[mid] = sub[4:].split(b"\0")[0].decode("utf-8", "replace")
                    elif sid == b"ltxt":
                        lengths[mid] = struct.unpack("<I", sub[4:8])[0]
                    p += 8 + ssz + (ssz & 1)
    return [(pos[i], lengths.get(i, 0), names.get(i, "")) for i in sorted(pos)]
