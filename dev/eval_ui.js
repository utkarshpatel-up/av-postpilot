// UI checks in the real window (developer only): autocomplete, Enter adds a row,
// Satsang Files removal rules.
(async () => {
  const log = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(600);                                   // series names load

  // 1. typing "dd vi" in Title line suggests "DD Vitraag"; Tab accepts it
  const t = $('e-title');
  t.focus(); t.value = '';
  for (const ch of 'dd vi') {
    t.value = t.value.slice(0, t.selectionStart) + ch;          // typing replaces the selected suggestion
    t.setSelectionRange(t.value.length, t.value.length);
    t.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch }));
  }
  log.push(`typed "dd vi" -> shows "${t.value}", selected "${t.value.slice(t.selectionStart, t.selectionEnd)}"`);
  t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  log.push(`after Tab -> "${t.value}"`);

  // 1b. Backspace keeps what was typed
  t.value = ''; for (const ch of 'apta') { t.value = t.value.slice(0, t.selectionStart) + ch; t.setSelectionRange(t.value.length, t.value.length); t.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch })); }
  log.push(`typed "apta" -> "${t.value}"`);
  // 2. Enter in the last row adds a row and focuses it
  const before = erows.length;
  const lastCount = [...document.querySelectorAll('#e-rows .e-count')].pop();
  lastCount.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wait(50);
  log.push(`rows ${before} -> ${erows.length}, active row is the new one: ${activeRow === erows.length - 1}`);

  // 3. Satsang Files: blocked with Move, allowed with Leave, comes back with Move
  document.querySelector('input[name=n-move][value=move]').click();
  await wait(300);
  document.querySelector('[data-del-folder="Satsang Files"]').click();
  await wait(300);
  log.push(`move: remove Satsang -> folders: ${projectFolderList().join(', ')} | toast: ${$('toast').textContent}`);
  document.querySelector('input[name=n-move][value=leave]').click();
  await wait(300);
  document.querySelector('[data-del-folder="Satsang Files"]').click();
  await wait(300);
  log.push(`leave: remove Satsang -> folders: ${projectFolderList().join(', ')}`);
  document.querySelector('input[name=n-move][value=copy]').click();
  await wait(300);
  log.push(`copy again -> folders: ${projectFolderList().join(', ')} | toast: ${$('toast').textContent}`);
  return log.join('\n');
})()
