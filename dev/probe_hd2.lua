local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local tl
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName():match('^CutQ 2') then tl = t end end
p:SetCurrentTimeline(tl)
local function job(name, settings)
  print(name, 'preset', p:LoadRenderPreset('YouTube - 720p'))
  settings.TargetDir = [[C:\Users\admin\Downloads\av-postpilot\dev\hd_out3]]; settings.CustomName = name
  p:SetRenderSettings(settings)
  local id = p:AddRenderJob()
  for _, j in ipairs(p:GetRenderJobList()) do if j.JobId == id then print('  ', name, j.FormatWidth .. 'x' .. j.FormatHeight) end end
  p:DeleteRenderJob(id)
end
job('A-noSelectAll', {})
job('B-selectAll', { SelectAllFrames = true })
