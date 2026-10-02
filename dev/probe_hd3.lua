local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local tl
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName() == 'Review EP-8911 Part 5' then tl = t end end
p:SetCurrentTimeline(tl)
local function check(label)
  local id = p:AddRenderJob()
  for _, j in ipairs(p:GetRenderJobList()) do if j.JobId == id then print(label, j.FormatWidth .. 'x' .. j.FormatHeight, j.OutputFilename) end end
  p:DeleteRenderJob(id)
end
p:SetRenderSettings({ TargetDir = [[C:\Users\admin\Downloads\av-postpilot\dev\hd_out3]] })
print(p:LoadRenderPreset('H.264 Master')); check('after H.264 Master')
print(p:LoadRenderPreset('YouTube - 720p')); check('after YouTube 720p')
print(p:LoadRenderPreset('YouTube - 720p')); check('again YouTube 720p')
print(p:LoadRenderPreset('Vimeo - 720p')); check('after Vimeo 720p')
local fmt = p:GetCurrentRenderFormatAndCodec(); print('format', fmt and fmt.format, fmt and fmt.codec)
