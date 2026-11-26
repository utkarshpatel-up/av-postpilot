// LUT conversion for the HandBrake Converter page. HandBrakeCLI cannot apply a LUT (no version has a
// LUT filter or preset setting), so with a LUT chosen each video is converted by PostPilot's FFmpeg
// instead: lut3d/lut1d applies the .cube, and the encode uses the main settings of the same HandBrake
// preset (encoder, quality, size, frame rate, deinterlace, audio). What can't be carried over (denoise,
// sharpen, …) is listed, so the page and the report can say so.
const fs = require('fs');
const path = require('path');

// The preset HandBrakeCLI would use: the first one in the exported file (nested or flat).
function readPreset(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  for (const p of data.PresetList || []) {
    const child = (p.ChildrenArray || []).find((c) => c.PresetName);
    if (child) return child;
    if (p.PresetName) return p;
  }
  throw Error('No preset name found in the preset file');
}

// A .cube LUT FFmpeg can read: a 3D or a 1D table, complete. Returns { kind, size, title }.
function readLut(file) {
  if (!fs.existsSync(file)) throw Error(`LUT file not found: ${file}`);
  if (path.extname(file).toLowerCase() !== '.cube') throw Error('Choose a .cube LUT file');
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  let size3 = 0, size1 = 0, title = '', rows = 0;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    let m;
    if ((m = l.match(/^LUT_3D_SIZE\s+(\d+)/i))) size3 = Number(m[1]);
    else if ((m = l.match(/^LUT_1D_SIZE\s+(\d+)/i))) size1 = Number(m[1]);
    else if ((m = l.match(/^TITLE\s+"?([^"]*)"?/i))) title = m[1].trim();
    else if (/^[-+\d.eE]+\s+[-+\d.eE]+\s+[-+\d.eE]+$/.test(l)) rows++;
  }
  if (size3 && size1) throw Error('This .cube has a 1D shaper and a 3D LUT together, which FFmpeg cannot read. Export it as a plain 3D LUT (.cube).');
  if (!size3 && !size1) throw Error('Not a .cube LUT (no LUT_3D_SIZE or LUT_1D_SIZE line)');
  const kind = size3 ? '3d' : '1d', size = size3 || size1;
  if (size < 2 || size > 256) throw Error(`The LUT size ${size} is not usable`);
  const want = kind === '3d' ? size ** 3 : size;
  if (rows !== want) throw Error(`The LUT is incomplete: ${rows} of ${want} colour rows (copied only partly?)`);
  return { kind, size, title };
}

// HandBrake encoder -> FFmpeg encoder, family and bit depth
const ENCODERS = {
  x265: ['libx265', 8], x265_10bit: ['libx265', 10], x265_12bit: ['libx265', 12],
  x264: ['libx264', 8], x264_10bit: ['libx264', 10],
  nvenc_h265: ['hevc_nvenc', 8], nvenc_h265_10bit: ['hevc_nvenc', 10], nvenc_h264: ['h264_nvenc', 8],
  nvenc_av1: ['av1_nvenc', 8], nvenc_av1_10bit: ['av1_nvenc', 10],
  qsv_h265: ['hevc_qsv', 8], qsv_h265_10bit: ['hevc_qsv', 10], qsv_h264: ['h264_qsv', 8],
  qsv_av1: ['av1_qsv', 8], qsv_av1_10bit: ['av1_qsv', 10],
  vce_h265: ['hevc_amf', 8], vce_h265_10bit: ['hevc_amf', 10], vce_h264: ['h264_amf', 8],
  vt_h265: ['hevc_videotoolbox', 8], vt_h265_10bit: ['hevc_videotoolbox', 10], vt_h264: ['h264_videotoolbox', 8],
  svt_av1: ['libsvtav1', 8], svt_av1_10bit: ['libsvtav1', 10],
};
const family = (enc) => ({ libx265: 'x265', libx264: 'x264', libsvtav1: 'svtav1' })[enc] || enc.split('_')[1];
const MAKER = { x265: 'x265', x264: 'x264', svtav1: 'SVT-AV1', nvenc: 'NVIDIA NVENC', qsv: 'Intel Quick Sync', amf: 'AMD', videotoolbox: 'Apple VideoToolbox' };
const codecName = (enc) => (enc.startsWith('hevc') || enc === 'libx265' ? 'H.265' : enc.startsWith('h264') || enc === 'libx264' ? 'H.264' : 'AV1');
// Named in the message when a preset's encoder is missing, only if this FFmpeg has them
const USABLE = { libx265: 'x265', hevc_nvenc: 'NVENC', hevc_qsv: 'Quick Sync', hevc_amf: 'AMD', hevc_videotoolbox: 'VideoToolbox' };
const NVENC_SPEED = { fastest: 'p1', faster: 'p2', fast: 'p3', medium: 'p4', slow: 'p5', slower: 'p6', slowest: 'p7' };
const QSV_SPEED = { speed: 'veryfast', balanced: 'medium', quality: 'veryslow' };
// HandBrake audio encoder -> FFmpeg encoder and its name on the page
const AUDIO = {
  aac: 'aac', av_aac: 'aac', ca_aac: 'aac', ca_haac: 'aac', fdk_aac: 'aac', fdk_haac: 'aac', mf_aac: 'aac',
  ac3: 'ac3', ffac3: 'ac3', eac3: 'eac3', ffeac3: 'eac3', opus: 'libopus', ffopus: 'libopus',
  mp3: 'libmp3lame', lame: 'libmp3lame', flac: 'flac', ffflac: 'flac', flac16: 'flac', flac24: 'flac', ffflac24: 'flac',
};
const AUDIO_LABEL = { aac: 'AAC', ac3: 'AC3', eac3: 'E-AC3', libopus: 'Opus', libmp3lame: 'MP3', flac: 'FLAC' };
const LOSSLESS = new Set(['flac']);
const CHANNELS = { mono: 1, left_only: 1, right_only: 1, stereo: 2, dpl1: 2, dpl2: 2, '5point1': 6, '6point1': 7, '7point1': 8, '5_2_lfe': 8 };
// "29.97" in a preset is NTSC's 30000/1001, not 2997/100
const NTSC = { 23.976: '24000/1001', 29.97: '30000/1001', 47.952: '48000/1001', 59.94: '60000/1001', 119.88: '120000/1001' };
const off = (v) => v === undefined || v === null || v === '' || v === 'off' || v === 'none' || v === false;

// The preset's settings as FFmpeg will use them, a short summary for the page, and what is left out.
// Throws when the preset's video encoder has no FFmpeg equivalent (or, given encoders, isn't in this FFmpeg).
function describePreset(p, encoders = null) {
  const hb = p.VideoEncoder || 'x264';
  if (!ENCODERS[hb]) throw Error(`The preset's video encoder (${hb}) can't be used with a LUT. Choose a preset with H.265, H.264 or AV1.`);
  const [encoder, bits] = ENCODERS[hb];
  const fam = family(encoder);
  const label = `${codecName(encoder)} ${MAKER[fam]}${bits > 8 ? ` ${bits}-bit` : ''}`;
  if (encoders && !encoders.has(encoder)) {
    const usable = Object.entries(USABLE).filter(([e]) => encoders.has(e)).map(([, name]) => name);
    throw Error(`The preset uses ${label}, which PostPilot's FFmpeg on this computer doesn't have (${encoder}). Choose a preset with ${usable.length ? usable.join(', ').replace(/, ([^,]+)$/, ' or $1') : 'another encoder'} for LUT conversion.`);
  }
  const ignored = [];
  const d = { encoder, family: fam, bits, label, hevc: codecName(encoder) === 'H.265' };
  d.quality = p.VideoQualityType === 1 ? { kbps: Number(p.VideoAvgBitrate) || 0 } : { rf: Number(p.VideoQualitySlider ?? 22) };
  if (d.quality.kbps === 0) d.quality = { rf: Number(p.VideoQualitySlider ?? 22) };
  if (p.VideoQualityType === 1 && p.VideoMultiPass) ignored.push('Multi-pass encoding (one pass is used)');
  const speed = String(p.VideoPreset || '');
  d.speed = { x265: speed, x264: speed, svtav1: /^\d+$/.test(speed) ? speed : '', nvenc: NVENC_SPEED[speed] || (/^p[1-7]$/.test(speed) ? speed : ''), qsv: QSV_SPEED[speed] || '', amf: ['speed', 'balanced', 'quality'].includes(speed) ? speed : '' }[fam] || '';
  if (speed && !d.speed) ignored.push(`Encoder speed preset "${speed}"`);
  const tune = off(p.VideoTune) ? '' : String(p.VideoTune);
  d.tune = fam === 'x265' || fam === 'x264' || (fam === 'nvenc' && /^(hq|uhq|ll|ull|lossless)$/.test(tune)) ? tune : '';
  if (tune && !d.tune) ignored.push(`Encoder tune "${tune}"`);
  d.profile = off(p.VideoProfile) || p.VideoProfile === 'auto' || fam === 'svtav1' ? '' : String(p.VideoProfile);
  const level = off(p.VideoLevel) || p.VideoLevel === 'auto' ? '' : String(p.VideoLevel);
  d.level = ['x265', 'x264', 'nvenc'].includes(fam) ? level : '';
  if (level && !d.level) ignored.push(`Encoder level ${level}`);
  const extra = String(p.VideoOptionExtra || '').trim();
  d.extra = fam === 'x265' || fam === 'x264' ? extra : '';
  if (extra && !d.extra) ignored.push('Advanced encoder options');

  // Picture: the preset's size is a box the video is fitted into (never enlarged unless the preset allows it)
  d.maxW = Number(p.PictureWidth) || 0; d.maxH = Number(p.PictureHeight) || 0;
  d.upscale = p.PictureAllowUpscaling === true;
  const crop = p.PictureCropMode ?? (p.PictureAutoCrop === false ? 2 : 0);
  if (crop === 3 || crop === 'custom') {
    d.crop = { t: Number(p.PictureTopCrop) || 0, b: Number(p.PictureBottomCrop) || 0, l: Number(p.PictureLeftCrop) || 0, r: Number(p.PictureRightCrop) || 0 };
    if (!d.crop.t && !d.crop.b && !d.crop.l && !d.crop.r) d.crop = null;
  } else if (crop === 0 || crop === 1 || crop === 'auto' || crop === 'conservative') ignored.push('Automatic cropping of black bars (the whole picture is kept)');
  const deint = String(p.PictureDeinterlaceFilter || 'off');
  d.deint = deint === 'off' ? null : { filter: deint === 'yadif' ? 'yadif' : 'bwdif', bob: p.PictureDeinterlacePreset === 'bob', all: off(p.PictureCombDetectPreset) };
  if (!off(p.PictureDenoiseFilter)) ignored.push(`Denoise (${p.PictureDenoiseFilter}${p.PictureDenoisePreset ? ` ${p.PictureDenoisePreset}` : ''})`);
  if (!off(p.PictureSharpenFilter)) ignored.push(`Sharpen (${p.PictureSharpenFilter})`);
  if (!off(p.PictureDeblockPreset)) ignored.push('Deblock');
  if (!off(p.PictureChromaSmoothPreset)) ignored.push('Chroma smooth');
  if (!off(p.PictureDetelecine)) ignored.push('Detelecine');
  if (!off(p.PictureColorspacePreset)) ignored.push('Colourspace conversion (the LUT sets the colour)');
  if (p.VideoGrayScale) ignored.push('Grayscale');
  if (p.PictureRotate && !/^angle=0:hflip=0$/.test(p.PictureRotate)) ignored.push('Rotate / flip');
  if (!off(p.PicturePadMode)) ignored.push('Padding');

  const rate = p.VideoFramerate && p.VideoFramerate !== 'auto' ? Number(p.VideoFramerate) : null;
  d.rate = rate || null; d.rateMode = p.VideoFramerateMode || 'vfr';
  d.faststart = Boolean(p.Mp4HttpOptimize);

  // Audio: every AudioList entry for the first (or every) audio track, like HandBrake
  d.tracks = { all: 'all', none: 'none' }[p.AudioTrackSelectionBehavior] || 'first';
  const mask = new Set((p.AudioCopyMask || []).map((c) => String(c).replace(/^copy:/, '')));
  const fallback = off(p.AudioEncoderFallback) ? null : AUDIO[p.AudioEncoderFallback] || 'aac';
  d.audio = (p.AudioList || []).map((a) => {
    const enc = String(a.AudioEncoder || 'aac');
    const copy = enc === 'copy' ? mask : enc.startsWith('copy:') ? new Set([enc.slice(5)]) : null;
    if (!copy && !AUDIO[enc]) ignored.push(`Audio encoder "${enc}" (AAC is used)`);
    if (Number(a.AudioTrackDRCSlider)) ignored.push('Audio dynamic range compression');
    const rateK = a.AudioSamplerate && a.AudioSamplerate !== 'auto' ? Math.round(Number(a.AudioSamplerate) * 1000) : null;
    return {
      copy, codec: copy ? fallback : AUDIO[enc] || 'aac', bitrate: Number(a.AudioBitrate) || 0, channels: CHANNELS[a.AudioMixdown] || 0,
      mixdown: CHANNELS[a.AudioMixdown] ? a.AudioMixdown : '', rate: rateK, gain: Number(a.AudioTrackGainSlider) || 0,
    };
  });
  if (d.tracks === 'none') d.audio = [];
  if (!off(p.SubtitleTrackSelectionBehavior) || p.SubtitleAddCC) ignored.push('Subtitles');

  const audioText = (a) => {
    const enc = a.codec ? `${AUDIO_LABEL[a.codec]}${a.bitrate && !LOSSLESS.has(a.codec) ? ` ${a.bitrate} kbps` : ''}${a.mixdown ? ` ${a.mixdown}` : ''}` : '';
    return a.copy ? `audio passed through (${[...a.copy].join('/') || 'none'})${enc ? `, else ${enc}` : ''}` : enc;
  };
  d.summary = [
    label,
    d.quality.kbps ? `${d.quality.kbps} kbps` : `quality ${d.quality.rf}`,
    d.maxW && d.maxH ? `up to ${d.maxW}×${d.maxH}` : 'same size',
    d.rate ? `${d.rateMode === 'cfr' ? '' : 'up to '}${d.rate} fps` : 'same frame rate',
    ...(d.deint ? [d.deint.all ? 'deinterlaced' : 'deinterlaced when interlaced'] : []),
    ...(d.audio.length ? d.audio.map(audioText) : ['no audio']),
  ];
  d.ignored = [...new Set(ignored)];
  return d;
}

// What FFmpeg says about an input (ffmpeg -i file, on stderr): duration, first real video stream, audio streams.
function parseProbe(text) {
  const t = text.match(/Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  const duration = t ? Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) : null;
  let video = null;
  const audio = [];
  for (const [, index, type, rest] of text.matchAll(/Stream #\d+:(\d+)[^:\n]*: (Video|Audio): ([^\n]*)/g)) {
    if (type === 'Audio') { audio.push({ index: Number(index), codec: rest.split(/[\s,]/)[0] }); continue; }
    if (video || /attached pic/.test(rest)) continue;
    const pf = rest.match(/, ((?:yuvj?|nv|p0|gbr|rgb|bgr|gray|ya)\w*)(?:\(([^)]*)\))?/);
    const props = pf && pf[2] ? pf[2].split(/,\s*/) : [];
    const size = rest.match(/, (\d{2,5})x(\d{2,5})\b/);
    const fps = rest.match(/, ([\d.]+) fps/);
    const matrix = (props.find((v) => /^(bt|smpte|fcc)/.test(v)) || '').split('/')[0] || null;
    video = {
      index: Number(index), pixFmt: pf ? pf[1] : '', range: props.includes('pc') || /^yuvj/.test(pf ? pf[1] : '') ? 'pc' : 'tv', matrix,
      width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null, fps: fps ? Number(fps[1]) : null,
    };
  }
  return { duration, video, audio };
}

const MATRIX = { bt709: 'bt709', bt470bg: 'bt601', smpte170m: 'bt601', bt601: 'bt601', bt2020nc: 'bt2020', bt2020c: 'bt2020', fcc: 'fcc', smpte240m: 'smpte240m' };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
function outPixFmt(fam, bits) {
  if (fam === 'x265' || fam === 'x264' || fam === 'svtav1') return { 8: 'yuv420p', 10: 'yuv420p10le', 12: 'yuv420p12le' }[bits];
  if (bits > 8) return 'p010le';
  return fam === 'nvenc' ? 'yuv420p' : 'nv12';
}

// The size after fitting into the preset's box, or null when the picture stays as it is.
function fitSize(w, h, maxW, maxH, upscale) {
  if (!w || !h) return null;
  let f = maxW && maxH ? Math.min(maxW / w, maxH / h) : 1;
  if (f > 1 && !upscale) f = 1;
  const W = even(w * f), H = even(h * f);
  return W === w && H === h ? null : { w: W, h: H };
}

// The FFmpeg arguments for one file. lut: { name, kind } of the LUT in FFmpeg's working folder
// (a plain name, so no path has to survive FFmpeg's filter escaping; see HandBrake.encodeLut).
function ffmpegArgs(d, probe, { input, output, lut }) {
  const v = probe.video || {};
  const vf = [];
  if (d.deint) vf.push(`${d.deint.filter}=mode=${d.deint.bob ? 'send_field' : 'send_frame'}:deint=${d.deint.all ? 'all' : 'interlaced'}`);
  let w = v.width, h = v.height;
  if (d.crop) { vf.push(`crop=iw-${d.crop.l + d.crop.r}:ih-${d.crop.t + d.crop.b}:${d.crop.l}:${d.crop.t}`); if (w && h) { w -= d.crop.l + d.crop.r; h -= d.crop.t + d.crop.b; } }
  // The LUT works on RGB: convert with the source's own matrix and range (HD and up is BT.709 when untagged)
  const matrix = MATRIX[v.matrix] || (v.height && v.height <= 576 ? 'bt601' : 'bt709');
  const fit = fitSize(w, h, d.maxW, d.maxH, d.upscale);
  const sizeOpt = fit ? `${fit.w}:${fit.h}:` : !w && d.maxW && d.maxH ? `w='min(iw,${d.maxW})':h='min(ih,${d.maxH})':force_original_aspect_ratio=decrease:force_divisible_by=2:` : '';
  vf.push(`scale=${sizeOpt}in_color_matrix=${matrix}:in_range=${v.range || 'tv'}:flags=lanczos+accurate_rnd+full_chroma_int`, 'format=gbrp16le');
  vf.push(lut.kind === '1d' ? `lut1d=file=${lut.name}:interp=linear` : `lut3d=file=${lut.name}:interp=tetrahedral`);
  // A LUT's output is Rec.709 video: convert back with that matrix and tag the file to match
  vf.push('scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int', `format=${outPixFmt(d.family, d.bits)}`);

  const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', v.index != null ? `0:${v.index}` : '0:v:0'];
  const sources = d.tracks === 'all' ? probe.audio : probe.audio.slice(0, 1);
  const audioArgs = [];
  let n = 0;
  for (const s of sources) {
    for (const a of d.audio) {
      const copy = a.copy && a.copy.has(s.codec);
      if (!copy && !a.codec) continue;   // passthrough only (no fallback), and this track can't be passed through
      args.push('-map', `0:${s.index}`);
      if (copy) audioArgs.push(`-c:a:${n}`, 'copy');
      else {
        audioArgs.push(`-c:a:${n}`, a.codec);
        if (a.bitrate && !LOSSLESS.has(a.codec)) audioArgs.push(`-b:a:${n}`, `${a.bitrate}k`);
        if (a.channels) audioArgs.push(`-ac:a:${n}`, String(a.channels));
        if (a.rate) audioArgs.push(`-ar:a:${n}`, String(a.rate));
        if (a.gain) audioArgs.push(`-filter:a:${n}`, `volume=${a.gain}dB`);
      }
      n++;
    }
  }
  args.push('-sn', '-dn', '-map_metadata', '0', '-vf', vf.join(','), '-c:v', d.encoder);

  const q = d.quality, num = (x) => String(Number(x)), int = (x) => String(Math.round(Number(x)));
  const quality = q.kbps ? (d.family === 'nvenc' ? ['-rc', 'vbr', '-b:v', `${q.kbps}k`] : ['-b:v', `${q.kbps}k`]) : {
    x265: ['-crf', num(q.rf)], x264: ['-crf', num(q.rf)], svtav1: ['-crf', int(q.rf)],
    nvenc: ['-rc', 'vbr', '-cq', num(q.rf), '-b:v', '0'], qsv: ['-global_quality', int(q.rf)],
    amf: ['-rc', 'cqp', '-qp_i', int(q.rf), '-qp_p', int(q.rf), ...(d.encoder === 'h264_amf' ? ['-qp_b', int(q.rf)] : [])],
    videotoolbox: ['-q:v', int(q.rf)],
  }[d.family];
  args.push(...quality);
  if (d.speed) args.push(d.family === 'amf' ? '-quality' : '-preset', d.speed);
  if (d.tune) args.push('-tune', d.tune);
  if (d.profile) args.push('-profile:v', d.profile);
  if (d.level && d.family !== 'x265') args.push('-level', d.level);
  const params = [d.extra, d.level && d.family === 'x265' ? `level-idc=${d.level}` : ''].filter(Boolean).join(':');
  if (params) args.push(d.family === 'x265' ? '-x265-params' : '-x264-params', params);
  if (d.hevc) args.push('-tag:v', 'hvc1');   // H.265 in MP4 that QuickTime and Apple devices play, as HandBrake writes it

  const fps = d.rate && (d.rateMode === 'cfr' || (d.rateMode === 'pfr' && v.fps && v.fps > d.rate + 0.01)) ? NTSC[d.rate] || String(d.rate) : null;
  if (fps) args.push('-r', fps, '-fps_mode', 'cfr');
  else if (d.rateMode === 'cfr') args.push('-fps_mode', 'cfr');

  args.push(...audioArgs);
  if (!n) args.push('-an');
  args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv');
  args.push('-f', 'mp4');
  if (d.faststart) args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats', output);
  return args;
}

module.exports = { readPreset, readLut, describePreset, parseProbe, ffmpegArgs, fitSize, ENCODERS };
