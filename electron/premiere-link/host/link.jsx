// AV PostPilot Link (ExtendScript side): a fixed set of commands, no free script execution.
// Assigned to $.global so a reload from inside a function replaces it for everyone.
var ppLink = $.global.ppLink = (function () {
  function q(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"'; }
  function str(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return q(v);
    var i, a = [];
    if (v instanceof Array) { for (i = 0; i < v.length; i++) a.push(str(v[i])); return '[' + a.join(',') + ']'; }
    for (i in v) if (v.hasOwnProperty(i)) a.push(q(i) + ':' + str(v[i]));
    return '{' + a.join(',') + '}';
  }
  function norm(p) { return String(p || '').replace(/\//g, '\\').toLowerCase(); }
  function has(list, x) { for (var i = 0; i < list.length; i++) if (list[i] === x) return true; return false; }
  // On Premiere's Home screen there is no project and touching app.project throws.
  function current() { try { return app.project && app.project.path ? String(app.project.path) : ''; } catch (e) { return ''; } }
  function sequences() {
    var out = [];
    try { if (current()) for (var i = 0; i < app.project.sequences.numSequences; i++) out.push(app.project.sequences[i].name); } catch (e) {}
    return out;
  }
  function status() {
    var r = { version: '', project: '', sequences: [], problems: [] };
    try { r.version = String(app.version); } catch (e) { r.problems.push('version: ' + e.message); }
    try { r.project = app.project ? String(app.project.path) : ''; } catch (e) { r.problems.push('project: ' + e.message); }
    try { if (r.project) for (var i = 0; i < app.project.sequences.numSequences; i++) r.sequences.push(String(app.project.sequences[i].name)); } catch (e) { r.problems.push('sequences: ' + e.message + ' line ' + e.line); }
    return r;
  }
  function open(a) {
    if (current() && norm(current()) === norm(a.path)) return { opened: false, project: current() };
    // suppress convert dialog, skip "locate media", skip warnings, keep out of the recent list
    var ok = app.openDocument(a.path, true, true, true, true);
    if (!ok || norm(current()) !== norm(a.path)) throw new Error('Premiere could not open ' + a.path);
    return { opened: true, project: current() };
  }
  // One frame of a sequence as PNG (for comparing Premiere's picture with Resolve's).
  function exportFrame(a) {
    var seq = null;
    for (var i = 0; i < app.project.sequences.numSequences; i++) if (app.project.sequences[i].name === a.sequence) seq = app.project.sequences[i];
    if (!seq) throw new Error('Sequence not found: ' + a.sequence);
    app.project.openSequence(seq.sequenceID);
    var active = app.project.activeSequence;
    var perFrame = Number(active.getSettings().videoFrameRate.ticks);
    active.setPlayerPosition(String(perFrame * a.frame));
    app.enableQE();
    var q = qe.project.getActiveSequence();
    if (!q) throw new Error('QE has no active sequence');
    var fps = Math.round(254016000000 / perFrame), f = a.frame;
    function two(n) { return (n < 10 ? '0' : '') + n; }
    var tc = two(Math.floor(f / (fps * 3600))) + ':' + two(Math.floor(f / (fps * 60)) % 60) + ':' + two(Math.floor(f / fps) % 60) + ':' + two(f % fps);
    function grab(path) {
      var target = new File(path);
      if (target.exists) target.remove();
      q.exportFramePNG(tc, target.fsName.replace(/\.png$/i, ''));
      for (var w = 0; w < 20 && !new File(target.fsName).exists; w++) $.sleep(500);
      return new File(target.fsName).exists ? target.fsName : '';
    }
    var result = { file: grab(a.file), timecode: tc };
    result.ok = result.file !== '';
    // The same frame without one clip (a title): the difference is exactly what that clip adds.
    if (a.without) {
      var track = active.videoTracks[a.without.track - 1], clip = null;
      for (var k = 0; track && k < track.clips.numItems; k++) {
        var c = track.clips[k];
        if (Math.abs(Math.round(Number(c.start.ticks) / perFrame) - a.without.start) <= 1) clip = c;
      }
      if (!clip) throw new Error('Clip to leave out not found on V' + a.without.track);
      clip.disabled = true;
      try { result.without = grab(a.withoutFile); } finally { clip.disabled = false; }
    }
    return result;
  }
  function exportXml(a) {
    if (norm(current()) !== norm(a.project)) throw new Error('That project is not the active project in Premiere');
    if (a.frame !== undefined) return exportFrame(a);
    var dir = new Folder(a.dir); if (!dir.exists) dir.create();
    var out = [], used = {};
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      if (a.names && a.names.length && !has(a.names, s.name)) continue;
      var base = String(s.name).replace(/[<>:"\/\\|?*]+/g, '_'), name = base, n = 2;
      while (used[name.toLowerCase()]) name = base + ' (' + (n++) + ')';
      used[name.toLowerCase()] = true;
      // Native OS path; success is judged by the file appearing (the call's return value varies by version).
      var target = new File(a.dir + '/' + name + '.xml');
      if (target.exists) target.remove();
      var answer = s.exportAsFinalCutProXML(target.fsName, 1);
      out.push({ name: s.name, file: target.fsName, ok: new File(target.fsName).exists, answer: String(answer) });
    }
    return { files: out };
  }
  function close(a) {
    if (current() && norm(current()) === norm(a.project)) { app.project.closeDocument(0, 0); return { closed: true }; }
    return { closed: false };
  }
  return {
    run: function (cmd, a) {
      try {
        // No chained ?: here: ExtendScript groups them left to right.
        var r = null;
        if (cmd === 'status') r = status();
        else if (cmd === 'open') r = open(a);
        else if (cmd === 'export') r = exportXml(a);
        else if (cmd === 'close') r = close(a);
        else throw new Error('Unknown command ' + cmd);
        r.ok = true; return str(r);
      } catch (e) { return str({ ok: false, error: cmd + ': ' + String(e.message || e) + (e.line ? ' (line ' + e.line + ')' : '') }); }
    }
  };
})();
