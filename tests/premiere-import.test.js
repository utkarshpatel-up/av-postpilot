const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { parseXml, analyze, locate } = require('../electron/premiere-project');
const { relinkXml, xmlSequenceName, fromUrl, toUrl, PremiereImport } = require('../electron/premiere-import');

const b64text = (text, font) => {
  const json = JSON.stringify({ mTextParam: { mAlignment: 2, mLeading: 36, mStyleSheet: { mFontName: { mParamValues: [[0, font]] }, mFontSize: { mParamValues: [[0, 270]] }, mFillColor: { mParamValues: [[0, 16777215]] } } }, mText: text });
  return Buffer.concat([Buffer.from('fc0e000000000000', 'hex'), Buffer.from(json, 'utf16le')]).toString('base64');
};
const kf = v => `<StartKeyframe>-91445760000000000,${v},0,0,0,0,0,0</StartKeyframe>`;
// A tiny project: one 25 fps sequence, V1 graded clip (Lumetri + Neat), V2 title, plus a slowed clip.
function project(dir) {
  const lumetriParams = Array.from({ length: 128 }, (_, i) => `<Param Index="${i}" ObjectRef="${1000 + i}"/>`).join('');
  const lumetriObjs = Array.from({ length: 128 }, (_, i) => `<VideoComponentParam ObjectID="${1000 + i}"><Name>p${i}</Name>${kf({ 16: 100, 41: 100, 19: 0.5, 20: 25 }[i] ?? 0)}</VideoComponentParam>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<PremiereData Version="3">
 <Project ObjectID="1" Version="42"/>
 <Sequence ObjectUID="seq"><TrackGroups><TrackGroup><First>228cda18-3625-4d2d-951e-348879e4ed93</First><Second ObjectRef="10"/></TrackGroup></TrackGroups><Name>Edit-1</Name></Sequence>
 <VideoTrackGroup ObjectID="10"><TrackGroup><Tracks><Track ObjectURef="t1"/><Track ObjectURef="t2"/></Tracks><FrameRate>10160640000</FrameRate></TrackGroup><FrameRect>0,0,3840,2160</FrameRect></VideoTrackGroup>
 <VideoClipTrack ObjectUID="t1"><ClipTrack><ClipItems><TrackItems><TrackItem ObjectRef="20"/><TrackItem ObjectRef="21"/></TrackItems></ClipItems></ClipTrack></VideoClipTrack>
 <VideoClipTrack ObjectUID="t2"><ClipTrack><ClipItems><TrackItems><TrackItem ObjectRef="22"/></TrackItems></ClipItems></ClipTrack></VideoClipTrack>
 <VideoClipTrackItem ObjectID="20"><ClipTrackItem><ComponentOwner><Components ObjectRef="30"/></ComponentOwner><TrackItem><Start>0</Start><End>${10160640000 * 50}</End></TrackItem><SubClip ObjectRef="40"/></ClipTrackItem></VideoClipTrackItem>
 <VideoClipTrackItem ObjectID="21"><ClipTrackItem><ComponentOwner><Components ObjectRef="31"/></ComponentOwner><TrackItem><Start>${10160640000 * 50}</Start><End>${10160640000 * 90}</End></TrackItem><SubClip ObjectRef="41"/></ClipTrackItem></VideoClipTrackItem>
 <VideoClipTrackItem ObjectID="22"><ClipTrackItem><ComponentOwner><Components ObjectRef="32"/></ComponentOwner><TrackItem><Start>0</Start><End>${10160640000 * 25}</End></TrackItem><SubClip ObjectRef="42"/></ClipTrackItem></VideoClipTrackItem>
 <VideoComponentChain ObjectID="30"><ComponentChain><Components><Component ObjectRef="50"/><Component ObjectRef="51"/></Components></ComponentChain></VideoComponentChain>
 <VideoComponentChain ObjectID="31"><ComponentChain><Components/></ComponentChain></VideoComponentChain>
 <VideoComponentChain ObjectID="32"><ComponentChain><Components><Component ObjectRef="52"/><Component ObjectRef="53"/></Components></ComponentChain></VideoComponentChain>
 <VideoFilterComponent ObjectID="50"><Component><Params>${lumetriParams}</Params><DisplayName>Lumetri Color</DisplayName></Component><MatchName>AE.ADBE Lumetri</MatchName></VideoFilterComponent>
 <VideoFilterComponent ObjectID="51"><Component><DisplayName>Reduce Noise v4 (SR)</DisplayName><InstanceName>Cam-04</InstanceName></Component><MatchName>AE.Neat_Video_4_PR_SR</MatchName></VideoFilterComponent>
 <VideoFilterComponent ObjectID="52"><Component><Params><Param ObjectRef="60"/></Params><DisplayName>Text</DisplayName></Component><MatchName>AE.ADBE Text</MatchName></VideoFilterComponent>
 <VideoFilterComponent ObjectID="53"><Component><Bypass>true</Bypass><DisplayName>Off</DisplayName></Component><MatchName>AE.Something</MatchName></VideoFilterComponent>
 <ArbVideoComponentParam ObjectID="60"><Name>Source Text</Name><StartKeyframeValue>${b64text('Hello & welcome', 'Calibri-Bold')}</StartKeyframeValue></ArbVideoComponentParam>
 ${lumetriObjs}
 <SubClip ObjectID="40"><Clip ObjectRef="70"/><Name>A.mov</Name></SubClip>
 <SubClip ObjectID="41"><Clip ObjectRef="71"/><Name>A.mov</Name></SubClip>
 <SubClip ObjectID="42"><Clip ObjectRef="72"/><Name>Graphic</Name></SubClip>
 <VideoClip ObjectID="70"><Clip><Source ObjectRef="80"/></Clip></VideoClip>
 <VideoClip ObjectID="71"><Clip><Source ObjectRef="80"/><PlaybackSpeed>0.5</PlaybackSpeed></Clip></VideoClip>
 <VideoClip ObjectID="72"><Clip><Source ObjectRef="81"/></Clip></VideoClip>
 <VideoMediaSource ObjectID="80"><MediaSource><Media ObjectURef="m1"/></MediaSource></VideoMediaSource>
 <VideoMediaSource ObjectID="81"><MediaSource><Media ObjectURef="m2"/></MediaSource></VideoMediaSource>
 <Media ObjectUID="m1"><FilePath>F:\\Old Drive\\Footage\\A.mov</FilePath><Title>A.mov</Title></Media>
 <Media ObjectUID="m2"><FilePath>1196574294</FilePath><Title>Graphic</Title></Media>
</PremiereData>`;
  const file = path.join(dir, 'Show.prproj');
  fs.mkdirSync(path.join(dir, 'Footage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Footage', 'A.mov'), '');
  fs.writeFileSync(file, zlib.gzipSync(xml));
  return file;
}

test('parseXml decodes entities and keeps nesting', () => {
  const doc = parseXml('<?xml version="1.0"?><a x="1 &amp; 2"><b>R &amp; D</b><c/></a>');
  const a = doc.children[0];
  assert.equal(a.attrs.x, '1 & 2');
  assert.deepEqual(a.children.map(c => c.name), ['b', 'c']);
});

test('analyze reports sequences, relinked media, looks, titles and speed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const r = analyze(project(dir), { fonts: ['Calibri Bold (TrueType)'] });
  assert.deepEqual(r.sequences.map(s => [s.name, s.width, s.height, s.fps, s.frames, s.videoClips]), [['Edit-1', 3840, 2160, 25, 90, 3]]);
  assert.equal(r.media.length, 1, 'the graphic is not a file');
  assert.equal(r.media[0].status, 'relinked');
  assert.equal(r.media[0].path, path.join(dir, 'Footage', 'A.mov'));
  assert.equal(r.gradeGroups.length, 1);
  assert.equal(r.gradeGroups[0].summary, 'Lumetri: Exposure +0.5, Contrast +25 + Neat Video (Cam-04)');
  assert.deepEqual(r.titles.map(t => [t.track, t.startFrame, t.endFrame, t.layers.map(l => [l.text, l.font, l.size, l.align, l.leading])]), [[2, 0, 25, [['Hello & welcome', 'Calibri-Bold', 270, 2, 36]]]]);
  assert.deepEqual(r.fonts, [{ name: 'Calibri-Bold', installed: true }]);
  const notes = r.fixes.flatMap(f => f.notes);
  assert.ok(notes.includes('Speed 50%: check'));
  assert.ok(!notes.some(n => /Off/.test(n)), 'bypassed effects are ignored');
});

test('locate tries the original, then the tail of the path under each folder', () => {
  const seen = new Set(['E:\\Archive\\Show\\Footage\\A.mov']);
  const exists = p => seen.has(p);
  assert.deepEqual(locate('F:\\Show\\Footage\\A.mov', { projectDir: 'E:\\Archive\\Show', exists }), { path: 'E:\\Archive\\Show\\Footage\\A.mov', status: 'relinked' });
  assert.equal(locate('F:\\Nope\\B.mov', { projectDir: 'E:\\Archive\\Show', exists }).status, 'missing');
});

test('pathurls convert both ways and XML is relinked', () => {
  const url = 'file://localhost/F%3a/Edit%201207/Satsang%20Files/NRI%20%26%20Other.mov';
  assert.equal(fromUrl(url), 'F:\\Edit 1207\\Satsang Files\\NRI & Other.mov');
  assert.equal(toUrl('E:\\Projects Done\\a & b.mov'), 'file://localhost/E:/Projects%20Done/a%20%26%20b.mov');
  assert.equal(fromUrl(toUrl('\\\\NAS\\share\\x y.mov')), '\\\\NAS\\share\\x y.mov');
  const xml = `<xmeml version="4"><sequence id="s"><uuid>u</uuid><name>Edit &amp; 1</name><media><pathurl>${url}</pathurl><pathurl>file://localhost/G%3a/gone.mov</pathurl></media></sequence></xmeml>`;
  assert.equal(xmlSequenceName(xml), 'Edit & 1');
  const r = relinkXml(xml, p => p.startsWith('F:') ? p.replace('F:\\Edit 1207', 'E:\\Done\\Edit 1207') : '');
  assert.equal(r.relinked, 1);
  assert.deepEqual(r.missing, ['G:\\gone.mov']);
  assert.match(r.text, /<pathurl>file:\/\/localhost\/E:\/Done\/Edit%201207\/Satsang%20Files\/NRI%20%26%20Other.mov<\/pathurl>/);
});

test('import relinks the XML, imports it and marks clips that need work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const file = project(dir);
  const synth = (id, src, s, e) => `<clipitem id="${id}"><name>${src}</name><start>${s}</start><end>${e}</end><in>0</in><out>${e - s}</out><file id="f-${id}"><name>${src}</name><mediaSource>${src}</mediaSource><media><video></video><audio></audio></media></file></clipitem>`;
  fs.writeFileSync(path.join(dir, 'Edit-1.xml'), `<?xml version="1.0"?><xmeml version="4"><sequence id="s"><name>Edit-1</name><media><video>
    <track>${synth('b', 'BarsAndTone', 0, 25)}<clipitem id="a"><name>A.mov</name><start>25</start><end>90</end><file id="fa"><pathurl>file://localhost/F%3a/Old%20Drive/Footage/A.mov</pathurl><media><video></video></media></file></clipitem></track>
    <track>${synth('t', 'GraphicAndTypeMaster', 0, 25)}${synth('k', 'Slug', 25, 50)}</track></video><audio><track>${synth('tone', 'BarsAndTone', 0, 25)}</track></audio></media></sequence></xmeml>`);
  const calls = [];
  const bridge = { barsStill: async () => ({ ok: true, path: path.join(dir, 'bars_smpte_3840x2160.png') }), premiere: async a => { calls.push(a);
    if (a.action === 'project') return { ok: true, project: 'Show', fps: '25', width: '3840', height: '2160' };
    if (a.action === 'import') return { ok: true, timelineId: 'TL', videoItems: 3, audioItems: 0, offline: 0 };
    if (a.action === 'mark') return { ok: true, placed: a.marks.length, lost: [] };
    if (a.action === 'bins') return { ok: true, imported: 2, skipped: 0, failed: [] };
    if (a.action === 'titles') return { ok: true, made: a.titles.length, lost: [] };
    return { ok: true, copied: 1, lost: 0 }; } };
  const pi = new PremiereImport({ bridge, dir: path.join(dir, 'work') });
  const s = pi.analyze(file);
  assert.equal(s.report.sequences[0].xml, path.join(dir, 'Edit-1.xml'));
  const r = await pi.importSequences(['Edit-1']);
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[0].relinked, 1);
  assert.deepEqual(calls[0], { action: 'project', name: 'Show', fps: 25, width: 3840, height: 2160 });
  const bins = calls.find(c => c.action === 'bins');
  assert.deepEqual(bins.base, []);
  const titleBin = bins.bins.find(b => b.path[0] === 'PostPilot Titles');
  assert.ok(/PostPilot title 3840x2160\.png$/.test(titleBin.files[0]), 'title placeholder imported');
  assert.ok(/bars_smpte_3840x2160\.png$/.test(titleBin.files[1]), 'colour bars still imported');
  const imported = fs.readFileSync(calls.find(c => c.action === 'import').xml, 'utf8');
  assert.ok(imported.includes(toUrl(path.join(dir, 'Footage', 'A.mov'))));
  assert.ok(!/<mediaSource>/.test(imported), 'no Premiere-generated clips left');
  assert.match(imported, /bars_smpte_3840x2160.png/);
  assert.match(imported, /<generatoritem id="postpilot-black-1">[\s\S]*<start>25<\/start><end>50<\/end>/);
  assert.ok(!/id="tone"/.test(imported), 'tone audio left out');
  const marks = calls.find(c => c.action === 'mark').marks;
  assert.deepEqual(marks.map(m => [m.track, m.start, m.color, m.name]), [[1, 0, 'Sky', 'Look 1'], [1, 50, 'Purple', 'Premiere: Speed 50%']]);
  const t = calls.find(c => c.action === 'titles').titles;
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].track, t[0].start, t[0].layers[0].text, t[0].layers[0].font, t[0].layers[0].style], [2, 0, 'Hello & welcome', 'Calibri', 'Bold']);
  assert.ok(Math.abs(t[0].layers[0].size - 270 / (0.8 * 3840)) < 1e-9);
});

