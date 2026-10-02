local r = bmd.scriptapp('Resolve', 'localhost')
local p = r:GetProjectManager():GetCurrentProject()
p:LoadRenderPreset('YouTube - 720p'); p:LoadRenderPreset('H.264 Master')
p:SetRenderSettings({ FormatWidth = 1280, FormatHeight = 720 })
local ok = p:SaveAsNewRenderPreset('PPCustomHD')
print('returned', ok == nil and 'nothing' or tostring(ok))
local raw = p:GetRenderPresetList() or {}
for k, v in pairs(raw) do if type(v) == 'string' and v:match('PP') then print('found at', k, v) end end
for k, v in pairs(raw) do if type(v) ~= 'string' then print('odd entry', k, type(v)) end end
