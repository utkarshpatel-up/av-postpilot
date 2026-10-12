// Dev: dump part of a .prproj object graph. node dev/prproj_dump.js <prproj> <ObjectType|id:N|uid:U> [depth] [index]
const { readProject } = require('../electron/premiere-project');
const [file, what, depth = 6, index = 0] = process.argv.slice(2);
const g = readProject(file);
const start = what.startsWith('id:') ? g.ids.get(what.slice(3)) : what.startsWith('uid:') ? g.uids.get(what.slice(4)) : g.ofType(what)[+index];
const seen = new Set();
function dump(n, d, pad) {
  const ref = n.attrs.ObjectRef || n.attrs.ObjectURef;
  const t = n.text.trim();
  console.log(pad + n.name + (ref ? ' -> ' + ref : '') + (t && !n.children.length ? ' = ' + t.slice(0, 100) : ''));
  if (d <= 0) return;
  if (ref) { const r = g.deref(n); if (r && !seen.has(r)) { seen.add(r); dump(r, d - 1, pad + '  '); } return; }
  for (const c of n.children) if (c.name !== 'Node' && !/Param$|^Params$/.test(c.name)) dump(c, d - 1, pad + '  ');
}
dump(start, +depth, '');
