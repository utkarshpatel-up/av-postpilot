// Dev: what sits in the first 10 s of each sequence (all video tracks), with source type.
// node dev/seq_heads.js <prproj>
const p = require('../electron/premiere-project');
const { child, kids, val } = p;
const g = p.readProject(process.argv[2]);
const types = {}; for (const o of g.objects) types[o.name] = (types[o.name] || 0) + 1;
console.log(Object.entries(types).filter(([k]) => /Title|Synth|Bars|Matte|Graphic|Text|Still|Image/i.test(k)).map(([k, v]) => k + ':' + v).join('  '));
for (const s of g.ofType('Sequence')) {
  const vg = kids(child(s, 'TrackGroups')).map(tg => g.deref(child(tg, 'Second'))).find(n => n && n.name === 'VideoTrackGroup');
  if (!vg) continue;
  const fps = +val(vg, 'TrackGroup/FrameRate');
  const out = [];
  kids(child(vg, 'TrackGroup/Tracks')).map(r => g.deref(r)).forEach((t, ti) => {
    for (const r of kids(child(t, 'ClipTrack/ClipItems/TrackItems'))) {
      const it = g.deref(r); const cti = child(it, 'ClipTrackItem');
      const st = Math.round(+val(cti, 'TrackItem/Start') / fps); if (st > 250) continue;
      const en = Math.round(+val(cti, 'TrackItem/End') / fps);
      const sub = g.deref(child(cti, 'SubClip')); const clip = g.deref(child(sub, 'Clip'));
      const src = g.deref(child(clip, 'Clip/Source')); const media = src && g.deref(child(src, 'MediaSource/Media'));
      const fx = kids(child(g.deref(child(cti, 'ComponentOwner/Components')), 'ComponentChain/Components')).map(x => val(g.deref(x), 'MatchName')).join(',');
      out.push(`V${ti + 1} ${st}-${en} "${val(sub, 'Name')}" src=${src && src.name} media=${media ? val(media, 'Title') + ' [' + val(media, 'FilePath').slice(-60) + '] impl=' + val(media, 'ImplementationID') : '-'} fx=${fx}`);
    }
  });
  console.log('\n## ' + val(s, 'Name')); out.forEach(l => console.log('  ' + l));
}
