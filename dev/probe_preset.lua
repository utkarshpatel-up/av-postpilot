local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local list = p:GetRenderPresetList() or {}
print('presets', #list)
for i, n in ipairs(list) do if i <= 40 then print('  ', n) end end
