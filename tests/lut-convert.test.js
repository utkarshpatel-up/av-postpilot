const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPreset, readLut, describePreset, parseProbe, ffmpegArgs, fitSize } = require('../electron/lut-convert');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lut-'));
const cube = (size, body = Array(size ** 3).fill('0.5 0.5 0.5').join('\n'), head = '') => `${head}LUT_3D_SIZE ${size}\n${body}\n`;
const write = (name, text) => { const p = path.join(tmp(), name); fs.writeFileSync(p, text); return p; };

// HandBrake's own "H.265 MKV 1080p30" (from HandBrakeCLI 1.9.2's built-in list), trimmed to what matters here
const H265_1080 = {
  PresetName: 'H.265 MKV 1080p30', VideoEncoder: 'x265_10bit', VideoQualityType: 2, VideoQualitySlider: 22.0, VideoPreset: 'slow', VideoProfile: 'main10',
  VideoLevel: 'auto', VideoTune: '', VideoMultiPass: true, VideoOptionExtra: 'strong-intra-smoothing=0:rect=0:aq-mode=1', VideoFramerate: '30', VideoFramerateMode: 'pfr',
  PictureWidth: 1920, PictureHeight: 1080, PictureCropMode: 0, PictureDeinterlaceFilter: 'decomb', PictureCombDetectPreset: 'default', PictureDeinterlacePreset: 'default',
  PictureDenoiseFilter: 'off', PictureSharpenFilter: 'off', PictureDeblockPreset: 'off', PictureChromaSmoothPreset: 'off', PictureColorspacePreset: 'off', PictureDetelecine: 'off',
  PictureRotate: 'angle=0:hflip=0', FileFormat: 'mkv', AudioTrackSelectionBehavior: 'first', AudioCopyMask: ['copy:aac'], AudioEncoderFallback: 'aac',
  AudioList: [{ AudioBitrate: 160, AudioEncoder: 'aac', AudioMixdown: 'stereo', AudioSamplerate: 'auto', AudioTrackDRCSlider: 0.0, AudioTrackGainSlider: 0.0 }],
  SubtitleTrackSelectionBehavior: 'none',
};
// What ffmpeg -i prints for a Sony XAVC camera clip
const XAVC = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:\\In\\Cam-01\\SHGINF_S001_S001_T001.MOV':
  Duration: 00:12:34.56, start: 0.000000, bitrate: 600123 kb/s
  Stream #0:0[0x1](und): Video: h264 (High 4:2:2 Intra) (avc1 / 0x31637661), yuv422p10le(tv, bt709, progressive), 3840x2160 [SAR 1:1 DAR 16:9], 599000 kb/s, 25 fps, 25 tbr, 25k tbn (default)
  Stream #0:1[0x2](und): Audio: pcm_s24le (in24 / 0x34326E69), 48000 Hz, 2 channels, s32 (24 bit), 2304 kb/s (default)
  Stream #0:2[0x3](und): Audio: pcm_s24le (in24 / 0x34326E69), 48000 Hz, 2 channels, s32 (24 bit), 2304 kb/s (default)
  Stream #0:3[0x4](eng): Data: none (tmcd / 0x64636D74), 0 kb/s
At least one output file must be specified`;
const LUT = { name: 'lut.cube', kind: '3d' };
const vf = (args) => args[args.indexOf('-vf') + 1];
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('a .cube LUT is checked: 3D, 1D, comments/BOM/CRLF, incomplete, shaper+3D, wrong file', () => {
  assert.deepStrictEqual(readLut(write('a.cube', `\uFEFF# Resolve\r\nTITLE "S-Log3 to 709"\r\n${cube(2).replace(/\n/g, '\r\n')}`)), { kind: '3d', size: 2, title: 'S-Log3 to 709' });
  assert.deepStrictEqual(readLut(write('b.cube', 'LUT_1D_SIZE 3\n0 0 0\n0.5 0.5 0.5\n1 1 1\n')), { kind: '1d', size: 3, title: '' });
  assert.throws(() => readLut(write('c.cube', cube(3, '0 0 0\n1 1 1'))), /incomplete: 2 of 27/);
  assert.throws(() => readLut(write('d.cube', `LUT_1D_SIZE 2\n${cube(2)}`)), /1D shaper and a 3D LUT/);
  assert.throws(() => readLut(write('e.cube', 'hello\n')), /Not a \.cube LUT/);
  assert.throws(() => readLut(write('f.3dl', cube(2))), /Choose a \.cube/);
  assert.throws(() => readLut(path.join(tmp(), 'gone.cube')), /LUT file not found/);
});

test('the preset is read like HandBrakeCLI reads it: first nested, else flat', () => {
  assert.strictEqual(readPreset(write('p.json', JSON.stringify({ PresetList: [{ ChildrenArray: [{ PresetName: 'Team', VideoEncoder: 'nvenc_h265' }] }] }))).VideoEncoder, 'nvenc_h265');
  assert.strictEqual(readPreset(write('q.json', JSON.stringify({ PresetList: [{ PresetName: 'Flat' }] }))).PresetName, 'Flat');
});

test("HandBrake's H.265 1080p30 preset becomes x265 10-bit at RF 22, fitted into 1080p, up to 30 fps", () => {
  const d = describePreset(H265_1080, new Set(['libx265']));
  assert.deepStrictEqual(d.summary, ['H.265 x265 10-bit', 'quality 22', 'up to 1920×1080', 'up to 30 fps', 'deinterlaced when interlaced', 'AAC 160 kbps stereo']);
  assert.deepStrictEqual(d.ignored, ['Automatic cropping of black bars (the whole picture is kept)']);
  const args = ffmpegArgs(d, parseProbe(XAVC), { input: 'in.MOV', output: 'out.mp4', lut: LUT });
  assert.strictEqual(vf(args), [
    'bwdif=mode=send_frame:deint=interlaced',
    'scale=1920:1080:in_color_matrix=bt709:in_range=tv:flags=lanczos+accurate_rnd+full_chroma_int', 'format=gbrp16le',
    'lut3d=file=lut.cube:interp=tetrahedral',
    'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int', 'format=yuv420p10le',
    // on the frames: FFmpeg 7.1 ignores -color_primaries/-color_trc and writes "unknown" without this
    'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
  ].join(','));
  assert.strictEqual(after(args, '-c:v'), 'libx265');
  assert.strictEqual(after(args, '-crf'), '22');
  assert.strictEqual(after(args, '-preset'), 'slow');
  assert.strictEqual(after(args, '-profile:v'), 'main10');
  assert.strictEqual(after(args, '-x265-params'), 'strong-intra-smoothing=0:rect=0:aq-mode=1');
  assert.strictEqual(after(args, '-tag:v'), 'hvc1');
  assert.ok(!args.includes('-r'), '25 fps is under the 30 fps peak: kept');
  // first audio track only, PCM can't be passed through: AAC
  assert.deepStrictEqual(args.filter((a, i) => args[i - 1] === '-map'), ['0:0', '0:1']);
  assert.deepStrictEqual([after(args, '-c:a:0'), after(args, '-b:a:0'), after(args, '-ac:a:0')], ['aac', '160k', '2']);
  assert.deepStrictEqual(args.slice(-4), ['-progress', 'pipe:1', '-nostats', 'out.mp4']);
  assert.ok(args.includes('-nostdin'), 'FFmpeg must never wait for keyboard input');
  for (const [k, v] of [['-color_primaries', 'bt709'], ['-color_trc', 'bt709'], ['-colorspace', 'bt709'], ['-color_range', 'tv'], ['-f', 'mp4']]) assert.strictEqual(after(args, k), v);
});

test('NVENC, Quick Sync, AMD and VideoToolbox get their own quality and speed options', () => {
  const p = { ...H265_1080, VideoOptionExtra: '', VideoProfile: 'auto', PictureCropMode: 2, VideoQualitySlider: 30 };
  const nv = ffmpegArgs(describePreset({ ...p, VideoEncoder: 'nvenc_h265', VideoPreset: 'slower' }), parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT });
  assert.deepStrictEqual(nv.slice(nv.indexOf('-c:v'), nv.indexOf('-c:v') + 10), ['-c:v', 'hevc_nvenc', '-rc', 'vbr', '-cq', '30', '-b:v', '0', '-preset', 'p6']);
  assert.match(vf(nv), /format=yuv420p,setparams=/);
  const nv10 = ffmpegArgs(describePreset({ ...p, VideoEncoder: 'nvenc_h265_10bit' }), parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT });
  assert.match(vf(nv10), /format=p010le,setparams=/);
  const qsv = describePreset({ ...p, VideoEncoder: 'qsv_h265', VideoPreset: 'quality' });
  assert.deepStrictEqual([qsv.speed, after(ffmpegArgs(qsv, parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT }), '-global_quality')], ['veryslow', '30']);
  const amf = ffmpegArgs(describePreset({ ...p, VideoEncoder: 'vce_h265', VideoPreset: 'balanced' }), parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT });
  assert.deepStrictEqual([after(amf, '-rc'), after(amf, '-qp_i'), after(amf, '-quality')], ['cqp', '30', 'balanced']);
  const vt = describePreset({ ...p, VideoEncoder: 'vt_h265_10bit', VideoPreset: 'speed' });
  assert.strictEqual(after(ffmpegArgs(vt, parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT }), '-q:v'), '30');
  assert.deepStrictEqual(vt.ignored, ['Encoder speed preset "speed"']);
});

test('a preset FFmpeg cannot follow is refused with a reason', () => {
  assert.throws(() => describePreset({ ...H265_1080, VideoEncoder: 'vp9' }), /video encoder \(vp9\) can't be used with a LUT/);
  assert.throws(() => describePreset({ ...H265_1080, VideoEncoder: 'nvenc_h265' }, new Set(['libx265', 'hevc_videotoolbox'])), /H\.265 NVIDIA NVENC, which PostPilot's FFmpeg on this computer doesn't have \(hevc_nvenc\)\. Choose a preset with x265 or VideoToolbox for LUT conversion\./);
});

test('filters FFmpeg does not copy from the preset are listed, not silently dropped', () => {
  const d = describePreset({ ...H265_1080, VideoQualityType: 1, VideoAvgBitrate: 8000, PictureDenoiseFilter: 'nlmeans', PictureDenoisePreset: 'light',
    PictureSharpenFilter: 'lapsharp', PictureRotate: 'angle=90:hflip=0', VideoGrayScale: true, SubtitleTrackSelectionBehavior: 'first' });
  assert.deepStrictEqual(d.ignored, ['Multi-pass encoding (one pass is used)', 'Automatic cropping of black bars (the whole picture is kept)',
    'Denoise (nlmeans light)', 'Sharpen (lapsharp)', 'Grayscale', 'Rotate / flip', 'Subtitles']);
  assert.strictEqual(d.summary[1], '8000 kbps');
  assert.strictEqual(after(ffmpegArgs(d, parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT }), '-b:v'), '8000k');
});

test('frame rate: constant forces the rate, peak only caps a faster source, NTSC rates are exact', () => {
  const probe50 = parseProbe(XAVC.replace(/25 fps/, '50 fps'));
  const cfr = ffmpegArgs(describePreset({ ...H265_1080, VideoFramerate: '29.97', VideoFramerateMode: 'cfr' }), parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT });
  assert.deepStrictEqual([after(cfr, '-r'), after(cfr, '-fps_mode')], ['30000/1001', 'cfr']);
  const pfr = ffmpegArgs(describePreset(H265_1080), probe50, { input: 'i', output: 'o', lut: LUT });
  assert.strictEqual(after(pfr, '-r'), '30');
  const same = ffmpegArgs(describePreset({ ...H265_1080, VideoFramerate: 'auto', VideoFramerateMode: 'vfr' }), probe50, { input: 'i', output: 'o', lut: LUT });
  assert.ok(!same.includes('-r') && !same.includes('-fps_mode'));
});

test('audio: passthrough when the source allows it, else the fallback; every track; none', () => {
  const aacSrc = parseProbe(XAVC.replace(/pcm_s24le \(in24[^)]*\)/g, 'aac (LC) (mp4a / 0x6134706D)'));
  const copyP = { ...H265_1080, AudioList: [{ AudioEncoder: 'copy:aac' }] };
  assert.strictEqual(after(ffmpegArgs(describePreset(copyP), aacSrc, { input: 'i', output: 'o', lut: LUT }), '-c:a:0'), 'copy');
  assert.strictEqual(after(ffmpegArgs(describePreset(copyP), parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT }), '-c:a:0'), 'aac');
  const noFallback = ffmpegArgs(describePreset({ ...copyP, AudioEncoderFallback: 'none' }), parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT });
  assert.ok(noFallback.includes('-an'), 'nothing to pass through and no fallback: no audio, like HandBrake');
  const all = ffmpegArgs(describePreset({ ...H265_1080, AudioTrackSelectionBehavior: 'all', AudioList: [{ AudioEncoder: 'aac', AudioBitrate: 128, AudioMixdown: 'mono', AudioSamplerate: '48', AudioTrackGainSlider: 3 }] }), parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT });
  assert.deepStrictEqual(all.filter((a, i) => all[i - 1] === '-map'), ['0:0', '0:1', '0:2']);
  assert.deepStrictEqual([after(all, '-ac:a:1'), after(all, '-ar:a:1'), after(all, '-filter:a:1')], ['1', '48000', 'volume=3dB']);
  const none = ffmpegArgs(describePreset({ ...H265_1080, AudioTrackSelectionBehavior: 'none' }), parseProbe(XAVC), { input: 'i', output: 'o', lut: LUT });
  assert.ok(none.includes('-an') && !none.includes('0:1'));
});

test('colour conversion follows the source: BT.709 HD, untagged SD, full range, BT.2020; custom crop; 1D LUT', () => {
  const d = describePreset({ ...H265_1080, PictureCropMode: 3, PictureTopCrop: 10, PictureBottomCrop: 10, PictureLeftCrop: 0, PictureRightCrop: 0 });
  const sd = parseProbe(XAVC.replace('yuv422p10le(tv, bt709, progressive), 3840x2160', 'yuv420p(progressive), 720x576'));
  assert.match(vf(ffmpegArgs(d, sd, { input: 'i', output: 'o', lut: LUT })), /^bwdif=[^,]+,crop=iw-0:ih-20:0:10,scale=in_color_matrix=bt601:in_range=tv:/);
  const untaggedHd = parseProbe(XAVC.replace('yuv422p10le(tv, bt709, progressive)', 'yuv422p10le(progressive)'));
  assert.match(vf(ffmpegArgs(d, untaggedHd, { input: 'i', output: 'o', lut: LUT })), /scale=1920:1070:in_color_matrix=bt709:in_range=tv:/, 'untagged HD/4K is BT.709, as Resolve treats it');
  const phone = parseProbe(XAVC.replace('yuv422p10le(tv, bt709, progressive)', 'yuv420p10le(pc, bt2020nc/bt2020/arib-std-b67)'));
  assert.match(vf(ffmpegArgs(d, phone, { input: 'i', output: 'o', lut: LUT })), /in_color_matrix=bt2020:in_range=pc/);
  assert.match(vf(ffmpegArgs(d, parseProbe(XAVC), { input: 'i', output: 'o', lut: { name: 'lut.cube', kind: '1d' } })), /lut1d=file=lut\.cube:interp=linear/);
});

test('ffmpeg -i output is read: duration, first real video stream, audio tracks', () => {
  const p = parseProbe(XAVC);
  assert.strictEqual(p.duration, 754.56);
  assert.deepStrictEqual(p.video, { index: 0, pixFmt: 'yuv422p10le', range: 'tv', matrix: 'bt709', width: 3840, height: 2160, fps: 25 });
  assert.deepStrictEqual(p.audio, [{ index: 1, codec: 'pcm_s24le' }, { index: 2, codec: 'pcm_s24le' }]);
  const cover = parseProbe(`  Duration: 00:00:05.00, start: 0.000000, bitrate: 100 kb/s
  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600, 90k tbr, 90k tbn (attached pic)
  Stream #0:1[0x2](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 8000 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)`);
  assert.deepStrictEqual([cover.video.index, cover.video.fps, cover.video.width], [1, 29.97, 1920]);
});

test("fitting into the preset's box keeps the shape, never enlarges, stays even", () => {
  assert.deepStrictEqual(fitSize(3840, 2160, 1920, 1080, false), { w: 1920, h: 1080 });
  assert.deepStrictEqual(fitSize(1080, 1920, 1920, 1080, false), { w: 608, h: 1080 });
  assert.strictEqual(fitSize(1280, 720, 1920, 1080, false), null);
  assert.deepStrictEqual(fitSize(1280, 720, 1920, 1080, true), { w: 1920, h: 1080 });
  assert.deepStrictEqual(fitSize(1919, 1079, 0, 0, false), { w: 1920, h: 1080 });
});
