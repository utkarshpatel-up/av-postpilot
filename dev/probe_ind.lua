local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local mp = p:GetMediaPool()
local root = mp:GetRootFolder()
local tmp = mp:AddSubFolder(root, 'PP temp ' .. os.time())
mp:SetCurrentFolder(tmp)
local clips = mp:ImportMedia({
  [[C:\Users\admin\Downloads\av-postpilot\dev\renders7\EP-8911 Part 5.mov]],
  [[C:\Users\admin\Downloads\av-postpilot\dev\renders7\EP-8911 Part 6.mov]] })
print('imported', #clips)
local tl = mp:CreateTimelineFromClips('PP HD temp', clips)
print('timeline', tl and tl:GetName(), #tl:GetItemListInTrack('video', 1))
p:SetCurrentTimeline(tl)
p:LoadRenderPreset('H.264 Master'); print('preset', p:LoadRenderPreset('YouTube - 720p'))
print('mode', p:SetCurrentRenderMode(0))
print('settings', p:SetRenderSettings({ TargetDir = [[C:\Users\admin\Downloads\av-postpilot\dev\hd_ind]] }))
local id = p:AddRenderJob()
for _, j in ipairs(p:GetRenderJobList()) do if j.JobId == id then print('job', j.RenderMode, j.OutputFilename, j.FormatWidth) end end
p:StartRendering({ id }, false)
while p:IsRenderingInProgress() do bmd.wait(0.5) end
print('status', p:GetRenderJobStatus(id).JobStatus)
print('TMPFOLDER', tmp:GetName())
