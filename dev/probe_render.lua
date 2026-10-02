local r = bmd.scriptapp('Resolve', 'localhost')
local p = r:GetProjectManager():GetCurrentProject()
local tl
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName():match('^SceneProbe') then tl = t end end
p:SetCurrentTimeline(tl)
p:DeleteAllRenderJobs()
p:SetRenderSettings({ TargetDir = [[C:\Users\admin\Downloads\av-postpilot\dev\renders]], CustomName = 'EP Test 01' })
local id = p:AddRenderJob()
print('job', id)
for _, j in ipairs(p:GetRenderJobList()) do for k, v in pairs(j) do print('  field', k, v) end end
print('status before', p:GetRenderJobStatus(id).JobStatus)
p:StartRendering(id)
local seen = {}
while true do
  local s = p:GetRenderJobStatus(id)
  if not seen[s.JobStatus] then print('status', s.JobStatus, s.CompletionPercentage); seen[s.JobStatus] = true end
  if not p:IsRenderingInProgress() then break end
  bmd.wait(0.3)
end
local s = p:GetRenderJobStatus(id)
for k, v in pairs(s) do print('  final', k, v) end
