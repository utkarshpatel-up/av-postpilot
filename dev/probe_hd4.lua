local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local tl
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName() == 'Review EP-8911 Part 5' then tl = t end end
p:SetCurrentTimeline(tl)
local function check(label)
  local id = p:AddRenderJob()
  for _, j in ipairs(p:GetRenderJobList()) do if j.JobId == id then print(label, j.FormatWidth .. 'x' .. j.FormatHeight, j.OutputFilename) end end
  p:DeleteRenderJob(id)
end
p:LoadRenderPreset('H.264 Master')
p:LoadRenderPreset('YouTube - 720p')
p:SetRenderSettings({ TargetDir = [[C:\Users\admin\Downloads\av-postpilot\dev\hd_out3]], CustomName = 'X1' }); check('preset then dir+name')
p:LoadRenderPreset('H.264 Master')
p:LoadRenderPreset('YouTube - 720p')
p:SetRenderSettings({ CustomName = 'X2' }); check('preset then name only')
p:LoadRenderPreset('H.264 Master')
p:LoadRenderPreset('YouTube - 720p')
p:SetRenderSettings({ SelectAllFrames = true }); check('preset then selectAll')
p:LoadRenderPreset('H.264 Master')
p:LoadRenderPreset('YouTube - 720p')
check('preset only')
