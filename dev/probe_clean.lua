local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local mp = p:GetMediaPool()
local root = mp:GetRootFolder()
local folder
for _, f in ipairs(root:GetSubFolderList()) do if f:GetName():match('^PP temp') then folder = f end end
local tls = {}
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName() == 'PP HD temp' then tls[#tls + 1] = t end end
print('found folder', folder and folder:GetName(), 'timelines', #tls)
print('delete timelines', mp:DeleteTimelines(tls))
local clips = folder:GetClipList()
print('clips left', #clips, 'delete clips', mp:DeleteClips(clips))
print('delete folder', mp:DeleteFolders({ folder }))
local still = 0
for _, f in ipairs(root:GetSubFolderList()) do if f:GetName():match('^PP temp') then still = still + 1 end end
local tlStill = 0
for i = 1, p:GetTimelineCount() do if p:GetTimelineByIndex(i):GetName() == 'PP HD temp' then tlStill = tlStill + 1 end end
print('remaining folders', still, 'remaining timelines', tlStill)
