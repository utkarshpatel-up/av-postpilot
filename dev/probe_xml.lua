local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject(); local mp=p:GetMediaPool()
local x = arg[1]
local a = mp:ImportTimelineFromFile(x, {timelineName='T1 test'}); print('plain name', a and a:GetName())
local b = mp:ImportTimelineFromFile(x, {timelineName='T2 test', importSourceClips=false}); print('no source clips', b and b:GetName())
local c = mp:ImportTimelineFromFile(x); print('no options', c and c:GetName())
