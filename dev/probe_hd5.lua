local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local tl
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName() == 'Review EP-8911 Part 5' then tl = t end end
p:SetCurrentTimeline(tl)
local function check(label)
  local id = p:AddRenderJob()
  for _, j in ipairs(p:GetRenderJobList()) do if j.JobId == id then print(label, j.FormatWidth .. 'x' .. j.FormatHeight) end end
  p:DeleteRenderJob(id)
end
p:LoadRenderPreset('YouTube - 720p'); check('1 loaded 720p')
p:SetRenderSettings({ FormatWidth = 1920, FormatHeight = 1080 }); check('2 changed to 1080 by hand')
p:LoadRenderPreset('YouTube - 720p'); check('3 same preset again')
p:LoadRenderPreset('H.264 Master'); p:LoadRenderPreset('YouTube - 720p'); check('4 other preset, then 720p')
