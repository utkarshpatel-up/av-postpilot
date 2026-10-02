local r = bmd.scriptapp('Resolve', 'localhost')
local p = r:GetProjectManager():GetCurrentProject()
local mp = p:GetMediaPool()
local items = mp:ImportMedia({[[C:\Users\admin\Downloads\av-postpilot\dev\cuts_test.mp4]]})
for i = 1, 2 do mp:CreateTimelineFromClips('CutQ ' .. i .. ' ' .. os.time(), items) end
p:DeleteAllRenderJobs()
print('ok')
