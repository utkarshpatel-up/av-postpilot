/* global pilot, esc */
// Project files (Feedback Cutter and Quiet Lift pages): the recorder audio of every Edit timeline in the open
// Resolve project (electron/project-audio.js), one row per recording:
//   2978 Dt-03 Jun 2026 → Edit-2978 M → Cam-04 (Audio) → 260603_0083-1
// kind 'fc' opens the recording, 'ql' its cleaned version (Feedback Cutter's save) when there is one.
// A file whose date isn't the day folder's is listed but can't be opened.
// projectFiles(el, { kind, pick }) -> { toggle, refresh, next(file) } ; pick(row, file) opens a row.
window.projectFiles = (el, { kind, pick }) => {
  let rows = [];
  const fileOf = (r) => (kind === 'ql' && r.cleaned) || r.file;
  const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

  function chips(r) {
    if (r.dateOk === false) return `<span class="pf-chip bad">date ${esc(r.date)} isn't ${esc(r.day)}</span>`;
    const out = [];
    if (r.dateOk === null) out.push('<span class="pf-chip">no date in the name</span>');
    if (kind === 'ql' && !r.cleaned) out.push('<span class="pf-chip warn">not cleaned yet</span>');
    else if (r.cleaned) out.push('<span class="pf-chip ok">cleaned</span>');
    if (r.lifted) out.push('<span class="pf-chip ok">lifted</span>');
    return out.join('');
  }

  function render(res) {
    if (!rows.length) {
      el.innerHTML = `<div class="pf-msg">No recorder audio found for the Edit timelines of "${esc(res.project)}".` +
        ' It is looked for in the Cam-XX (Audio) folders below each Edit timeline\'s day folder.</div>';
    } else {
      let last = '';
      el.innerHTML = rows.map((r, i) => {
        const head = r.timeline !== last ? `<div class="pf-group">${esc(r.timeline)}</div>` : '';
        last = r.timeline;
        return `${head}<button class="pf-row" data-i="${i}" ${r.dateOk === false ? 'disabled' : ''}>` +
          `<span class="pf-path">${esc(r.day)} → ${esc(r.timeline)} → ${esc(r.cam)} → <b>${esc(r.name)}</b></span>${chips(r)}</button>`;
      }).join('');
    }
    if (res.missing.length) {
      el.insertAdjacentHTML('beforeend', `<div class="pf-msg">No day folder found for ${res.missing.map(esc).join(', ')}.</div>`);
    }
  }

  async function refresh() {
    if (!rows.length) el.innerHTML = '<div class="pf-msg">Reading the open Resolve project…</div>';
    const res = await pilot.projectAudio();
    if (!res.ok) { rows = []; el.innerHTML = `<div class="pf-msg">${esc(res.error)}</div>`; return; }
    rows = res.rows;
    render(res);
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('.pf-row');
    if (b && !b.disabled) pick(rows[b.dataset.i], fileOf(rows[b.dataset.i]));
  });

  return {
    toggle() {
      el.hidden = !el.hidden;
      if (!el.hidden) refresh();
    },
    refresh() { if (!el.hidden) refresh(); },
    // the row after the one this file belongs to (any of its versions), for "Next file"
    next(file) {
      const i = rows.findIndex((r) => [r.file, r.cleaned, r.lifted].some((f) => same(f, file)));
      return i < 0 ? null : rows.slice(i + 1).find((r) => r.dateOk !== false) || null;
    },
    fileOf,
  };
};
