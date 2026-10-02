local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
p:DeleteAllRenderJobs()
local n = 0
for i = 1, p:GetTimelineCount() do
  local t = p:GetTimelineByIndex(i)
  if t:GetName():match('^CutQ') then
    n = n + 1
    p:SetCurrentTimeline(t)
    p:LoadRenderPreset('YouTube - 720p'); p:LoadRenderPreset('H.264 Master'); p:SetCurrentRenderMode(1)
    p:SetRenderSettings({ TargetDir = [[C:\Users\admin\Downloads\av-postpilot\dev\e2e_main]], CustomName = n == 1 and 'Hindi Shibir-07 (2980M, 2980E)' or 'Hindi Shibir-08 (2980E)' })
    p:AddRenderJob()
  end
end
print('jobs', #p:GetRenderJobList(), 'start', p:StartRendering())
