(async () => {
  const src = 'C:/Users/admin/Downloads/av-postpilot/dev/enc_src';
  const log = [];
  // 1. no groups yet: "+ Add Files" path -> Group 1 is created
  await addToGroup(null, [src + '/clip25.mp4']);
  await new Promise((r) => setTimeout(r, 400));
  log.push('after first add: ' + enc.groups.map((g) => `${g.name}:${g.items.length}`).join(', '));
  // 2. drop outside a group -> new group
  await addToGroup(await newGroup(), [src + '/clip30.mp4']);
  await new Promise((r) => setTimeout(r, 400));
  log.push('after drop outside: ' + enc.groups.map((g) => `${g.name}:${g.items.length}`).join(', '));
  // 3. select Group 1 and add again -> goes into Group 1
  selectedGroup = enc.groups[0].id;
  await addToGroup(null, [src]);
  await new Promise((r) => setTimeout(r, 400));
  log.push('after add to selected Group 1: ' + enc.groups.map((g) => `${g.name}:${g.items.length}`).join(', '));
  // folder template: add + remove
  await save((s) => { s.project.folders = [...projectFolderList(), 'Graphics']; });
  await save((s) => { s.project.folders = projectFolderList().filter((f) => f !== 'Scratch Disk'); });
  log.push('folders: ' + projectFolderList().join(', '));
  return log.join('\n');
})()
