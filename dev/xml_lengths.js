// Dev: FCP7 XML with a 750-frame and a 75-frame PNG title clip, then 750 + 75 frames of Color generator.
// node dev/xml_lengths.js <png> <out.xml>
const fs = require('fs');
const [png, out] = process.argv.slice(2);
const url = 'file://localhost/' + png.replace(/\\/g, '/').split('/').map((s, i) => i === 0 ? s : encodeURIComponent(s)).join('/');
const rate = '<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>';
const still = (id, s, e, first) => `<clipitem id="${id}"><name>PostPilot title</name><enabled>TRUE</enabled><duration>${e - s}</duration>${rate}<start>${s}</start><end>${e}</end><in>0</in><out>${e - s}</out>${first ? `<file id="pp"><name>t.png</name><pathurl>${url}</pathurl><media><video><samplecharacteristics><width>3840</width><height>2160</height></samplecharacteristics></video></media></file>` : '<file id="pp"/>'}</clipitem>`;
const color = (id, s, e) => `<generatoritem id="${id}"><name>Black</name><enabled>TRUE</enabled><duration>${e - s}</duration>${rate}<start>${s}</start><end>${e}</end><in>0</in><out>${e - s}</out><effect><name>Color</name><effectid>Color</effectid><effectcategory>Matte</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype></effect></generatoritem>`;
const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE xmeml><xmeml version="4"><sequence id="seq"><name>probe xml lengths</name><duration>1650</duration>${rate}<media><video><format><samplecharacteristics>${rate}<width>3840</width><height>2160</height></samplecharacteristics></format><track>${still('a', 0, 750, true)}${color('b', 750, 1500)}${still('c', 1500, 1575)}${color('d', 1575, 1650)}</track></video></media></sequence></xmeml>`;
fs.writeFileSync(out, xml);
