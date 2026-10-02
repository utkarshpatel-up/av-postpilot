local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local tl
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName() == 'PP HD temp' then tl = t end end
p:SetCurrentTimeline(tl)
local function job(label)
  local id = p:AddRenderJob()
  for _, j in ipairs(p:GetRenderJobList()) do if j.JobId == id then print(label, 'mode now', p:GetCurrentRenderMode(), '->', j.RenderMode, j.OutputFilename) end end
  p:DeleteRenderJob(id)
end
print('current mode', p:GetCurrentRenderMode())
p:SetCurrentRenderMode(1); job('set 1')
p:SetCurrentRenderMode(0); job('set 0')
p:SetCurrentRenderMode(0); p:SetRenderSettings({ TargetDir = [[C:\Users\admin\Downloads\av-postpilot\dev\hd_ind]] }); job('set 0 then settings')
