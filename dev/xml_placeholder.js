// Dev: replace the first Premiere title clipitem in an FCP XML by a generator item.
// node dev/xml_placeholder.js <in.xml> <out.xml> <effectid>
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const re = /<clipitem\b[^>]*>(?:(?!<\/clipitem>)[\s\S])*?<mediaSource>GraphicAndType<\/mediaSource>[\s\S]*?<\/clipitem>/;
const body = src.match(re)[0];
const g = k => +(body.match(new RegExp(`<${k}>(-?\\d+)</${k}>`)) || [])[1];
const id = process.argv[4];
const gen = `<generatoritem id="pp-title-1">
<name>PostPilot Title</name><enabled>TRUE</enabled><duration>${g('end') - g('start')}</duration>
<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
<start>${g('start')}</start><end>${g('end')}</end><in>0</in><out>${g('end') - g('start')}</out>
<effect><name>${id}</name><effectid>${id}</effectid><effectcategory>Matte</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype></effect>
</generatoritem>`;
fs.writeFileSync(process.argv[3], src.replace(re, gen));
console.log('start', g('start'), 'end', g('end'));
