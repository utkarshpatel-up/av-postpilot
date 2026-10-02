local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local list = p:GetRenderPresetList() or {}
print('total presets', #list)
for i = 21, #list do print('  ', list[i]) end
-- make a custom preset like an editor would: start from H.264 Master, change size, save
p:LoadRenderPreset('YouTube - 720p'); p:LoadRenderPreset('H.264 Master')
p:SetRenderSettings({ FormatWidth = 1280, FormatHeight = 720 })
print('save custom', p:SaveAsNewRenderPreset('PP Custom HD Test'))
local found = false
for _, n in ipairs(p:GetRenderPresetList() or {}) do if n == 'PP Custom HD Test' then found = true end end
print('custom in list', found)
p:LoadRenderPreset('H.264 Master')
print('load custom', p:LoadRenderPreset('PP Custom HD Test'))
local id = p:AddRenderJob()
for _, j in ipairs(p:GetRenderJobList()) do if j.JobId == id then print('job size', j.FormatWidth .. 'x' .. j.FormatHeight) end end
p:DeleteRenderJob(id)
