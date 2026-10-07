const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const runner = process.env.AVPP_LUA_RUNNER || 'C:/Program Files/Blackmagic Design/DaVinci Resolve/fuscript.exe';

// Exercise the actual Lua command handlers against an in-memory Resolve model.
// Never connects to Resolve or changes a real project/library.
test('Lua workspace saves before closing and only deletes its owned project', { skip: !fs.existsSync(runner) }, () => {
  const bridge = fs.readFileSync(path.join(__dirname, '../electron/bridge.lua'), 'utf8');
  for (const scenario of ['success', 'empty', 'saveFail', 'closeFail', 'createFail', 'switch', 'rename', 'database', 'rendering']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avpp-lua-'));
    const file = path.join(dir, 'check.lua');
    fs.writeFileSync(file, `
local scenario = '${scenario}'
local events, replies = {}, {}
local function event(s) events[#events+1] = s end
local function make(name, id)
  return { GetName = function() return name end, GetUniqueId = function() return id end,
    IsRenderingInProgress = function() return scenario == 'rendering' and id == 'main' end }
end
local original = make('Main', 'main')
local current = scenario ~= 'empty' and original or nil
local pm = {}
function pm:GetCurrentProject() return current end
function pm:SaveProject() event('save'); return scenario ~= 'saveFail' end
function pm:CloseProject(p) event('close:'..p:GetUniqueId()); if scenario == 'closeFail' then return false end; current = nil; return true end
function pm:CreateProject(name) event('create'); if scenario == 'createFail' then return nil end; current = make(name, 'scratch'); return current end
function pm:GetCurrentFolder() return 'Root' end
function pm:GetCurrentDatabase() return { DbName = scenario == 'database' and #replies > 1 and 'Changed' or 'Local', DbType = 'Disk' } end
function pm:DeleteProject(name) event('delete:'..name); assert(current == nil); assert(name == 'Scratch'); return true end
function pm:LoadProject(name) error('Encoder must not reopen a project') end
bmd = { scriptapp = function() return { GetProjectManager = function() return pm end } end }
local lines = { 'encbegin\\t{token="t",name="Scratch",originalId="${scenario === 'empty' ? '' : 'main'}"}', 'encfinish\\t{token="t"}' }
local index = 0
io.read = function()
  index = index + 1
  if index == 2 and scenario == 'switch' then current = original end
  if index == 2 and scenario == 'rename' and current then current = make('Renamed', 'scratch') end
  return lines[index]
end
io.write = function(s) replies[#replies+1] = s end
${bridge}
local actual = table.concat(events, ',')
local expected = {
 success='save,close:main,create,close:scratch,delete:Scratch',
 empty='create,close:scratch,delete:Scratch',
 saveFail='save', closeFail='save,close:main', createFail='save,close:main,create',
 switch='save,close:main,create', rename='save,close:main,create', database='save,close:main,create', rendering=''
}
assert(actual == expected[scenario], scenario..': '..actual)
print('workspace-ok')
`);
    try {
      const out = execFileSync(runner, ['-l', 'lua', file], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
      assert.match(out, /workspace-ok/, scenario);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
