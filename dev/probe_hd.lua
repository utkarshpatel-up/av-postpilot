local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local src
for _, j in ipairs(p:GetRenderJobList()) do if p:GetRenderJobStatus(j.JobId).JobStatus == 'Complete' then src = j end end
print('source job', src.OutputFilename, src.TimelineName, src.MarkIn, src.MarkOut, src.FormatWidth)
local tl
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName() == src.TimelineName then tl = t end end
print('set timeline', p:SetCurrentTimeline(tl))
print('load preset', p:LoadRenderPreset('YouTube - 720p'))
print('settings', p:SetRenderSettings({ TargetDir = [[C:\Users\admin\Downloads\av-postpilot\dev\hd_out]], CustomName = 'EP-8911 Part 5 HD', MarkIn = src.MarkIn, MarkOut = src.MarkOut }))
local id = p:AddRenderJob()
print('hd job', id)
for _, j in ipairs(p:GetRenderJobList()) do if j.JobId == id then print('  ->', j.OutputFilename, j.FormatWidth .. 'x' .. j.FormatHeight, j.TargetDir) end end
print('start', p:StartRendering({ id }, false))
while p:IsRenderingInProgress() do bmd.wait(0.5) end
print('status', p:GetRenderJobStatus(id).JobStatus)
