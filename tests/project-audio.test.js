const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dayDate, recorderName, projectAudio, timelineFor } = require('../electron/project-audio');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), '');
  }
  return root;
}

test('the day folder\'s date as the recorder writes it, and the recorder\'s names', () => {
  assert.strictEqual(dayDate('2978 Dt-03 Jun 2026'), '260603');
  assert.strictEqual(dayDate('1207 Dt-28 Nov 2018'), '181128');
  assert.strictEqual(dayDate('Projects Done'), null);
  assert.deepStrictEqual(recorderName('260603_0083-1'), { date: '260603', clip: 83, channel: 1 });
  assert.deepStrictEqual(recorderName('260603_0084-02'), { date: '260603', clip: 84, channel: 2 });
  assert.deepStrictEqual(recorderName('Cam-05 Varanasi Darshan Clip-003'), { date: null, clip: 3, channel: null });
});

test('Edit-2978 lists its day\'s Cam-XX (Audio) recordings in clip order, checking the date', () => {
  const day = '2978 Dt-03 Jun 2026';
  const cam = `Satsang Files/${day}/Clips for Insert/Cam-04 (Audio)`;
  const root = tree([
    `Satsang Files/${day}/Topic E Dt-03-Jun-26/Clip-01.mov`,
    `${cam}/260603_0084-2.wav`, `${cam}/260603_0083-1.wav`, `${cam}/260603_0084-1.wav`, `${cam}/260603_0083-2.wav`,
    `${cam}/260602_0099-1.wav`,                                   // another day's file
    `${cam}/260603_0083-1 (fc-cleaned).wav`, `${cam}/260603_0083-1-lifted.wav`,
    `${cam}/RX Temp Save File 260603_0083-25EF2.wav`, `${cam}/notes.txt`,
  ]);
  const timelines = [{ name: 'Edit-2978', files: [path.join(root, `Satsang Files/${day}/Topic E Dt-03-Jun-26/Clip-01.mov`)] }];
  const { rows, missing } = projectAudio(timelines);
  assert.deepStrictEqual(missing, []);
  assert.deepStrictEqual(rows.map((r) => [r.name, r.dateOk]), [
    ['260603_0083-1', true], ['260603_0083-2', true], ['260603_0084-1', true], ['260603_0084-2', true], ['260602_0099-1', false],
  ]);
  assert.deepStrictEqual([rows[0].day, rows[0].timeline, rows[0].cam], [day, 'Edit-2978', 'Cam-04 (Audio)']);
  assert.strictEqual(path.basename(rows[0].cleaned), '260603_0083-1 (fc-cleaned).wav');
  assert.strictEqual(path.basename(rows[0].lifted), '260603_0083-1-lifted.wav');
  assert.strictEqual(rows[1].cleaned, '');

  // Send to Resolve: the lifted file goes on Edit-2978; another day's file too, with the mismatch to warn about
  assert.deepStrictEqual(timelineFor(path.join(root, cam, '260603_0084-2-lifted.wav'), timelines), { name: 'Edit-2978', clip: 84 });
  assert.deepStrictEqual(timelineFor(path.join(root, cam, '260602_0099-1-lifted.wav'), timelines), {
    name: 'Edit-2978', clip: 99, mismatch: 'the date in its name (260602) and the folder\'s date (2978 Dt-03 Jun 2026) don\'t match',
  });
  assert.match(timelineFor(path.join(root, 'elsewhere', '260603_0083-1-lifted.wav'), timelines).why, /not in the day folder/);
});

test('a day with two sessions: each Cam folder belongs to the Edit timeline of its session', () => {
  const day = '3001 Dt-10 Sep 2026';
  const s1 = `${day}/01 Topic E1 Dt-10-Sep-26`, s2 = `${day}/02 Topic E2 Dt-10-Sep-26`;
  const root = tree([
    `${s1}/Clip-01.mov`, `${s2}/Clip-01.mov`,
    `${s1}/Clips for Insert/Cam-02 (Audio)/260910_0083-1.wav`,
    `${s2}/Clips for Insert/Cam-02 (Audio)/260910_0090-1.wav`,
  ]);
  const timelines = [
    { name: 'Edit-3001 E1', files: [path.join(root, s1, 'Clip-01.mov')] },
    { name: 'Edit-3001 E2', files: [path.join(root, s2, 'Clip-01.mov')] },
    { name: 'Edit-4000', files: [path.join(root, 'loose', 'Clip-01.mov')] },   // no day folder
  ];
  const { rows, missing } = projectAudio(timelines);
  assert.deepStrictEqual(rows.map((r) => [r.timeline, r.name]), [['Edit-3001 E1', '260910_0083-1'], ['Edit-3001 E2', '260910_0090-1']]);
  assert.deepStrictEqual(missing, ['Edit-4000']);
  assert.strictEqual(timelineFor(path.join(root, s2, 'Clips for Insert/Cam-02 (Audio)/260910_0090-1-lifted.wav'), timelines).name, 'Edit-3001 E2');
});

test('the cleaned copy kept in .postpilot and the final "(cleaned+lifted)" file, next to it or in the chosen folder', () => {
  const day = '2978 Dt-03 Jun 2026';
  const cam = `${day}/Clips for Insert/Cam-04 (Audio)`;
  const root = tree([
    `${day}/Topic E Dt-03-Jun-26/Clip-01.mov`,
    `${cam}/260603_0083-1.wav`, `${cam}/260603_0083-2.wav`, `${cam}/260603_0084-1.wav`,
    `${cam}/.postpilot/260603_0083-1 (fc-cleaned).wav`, `${cam}/.postpilot/260603_0083-2 (fc-cleaned).wav`,
    `${cam}/260603_0083-1 (cleaned+lifted).wav`,                // final next to the recording
    'Finals/260603_0083-2 (cleaned+lifted) 2.wav',              // final in the chosen folder
    `${cam}/260603_0084-1 (ql-lifted).wav`,                     // lifted without cleaning first
  ]);
  const timelines = [{ name: 'Edit-2978', files: [path.join(root, `${day}/Topic E Dt-03-Jun-26/Clip-01.mov`)] }];
  const { rows } = projectAudio(timelines, { outDir: path.join(root, 'Finals') });
  assert.deepStrictEqual(rows.map((r) => [r.name, path.basename(r.cleaned), path.basename(r.lifted)]), [
    ['260603_0083-1', '260603_0083-1 (fc-cleaned).wav', '260603_0083-1 (cleaned+lifted).wav'],
    ['260603_0083-2', '260603_0083-2 (fc-cleaned).wav', '260603_0083-2 (cleaned+lifted) 2.wav'],
    ['260603_0084-1', '', '260603_0084-1 (ql-lifted).wav'],
  ]);
  assert.strictEqual(path.basename(path.dirname(rows[0].cleaned)), '.postpilot');
  // a final saved in the chosen folder goes on the Edit timeline of its original recording
  assert.strictEqual(timelineFor(path.join(root, 'Finals', '260603_0083-2 (cleaned+lifted) 2.wav'), timelines).why !== undefined, true);
  assert.deepStrictEqual(timelineFor(path.join(root, cam, '260603_0083-2.wav'), timelines), { name: 'Edit-2978', clip: 83 });
});
