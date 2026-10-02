local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local tl
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName() == 'PP HD temp' then tl = t end end
p:SetCurrentTimeline(tl)
p:LoadRenderPreset('YouTube - 720p'); p:LoadRenderPreset('H.264 Master')
print('mode', p:SetCurrentRenderMode(0), p:GetCurrentRenderMode())
p:SetRenderSettings({ TargetDir = [[C:\Users\admin\Downloads\av-postpilot\dev\hd_ind3]], FormatWidth = 1280, FormatHeight = 720, UniqueFilenameStyle = 0 })
local id = p:AddRenderJob()
for _, j in ipairs(p:GetRenderJobList()) do if j.JobId == id then print('job', j.RenderMode, j.OutputFilename, j.FormatWidth) end end
p:StartRendering({ id }, false)
while p:IsRenderingInProgress() do bmd.wait(0.5) end
print('status', p:GetRenderJobStatus(id).JobStatus)
