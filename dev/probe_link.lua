local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject(); local mp=p:GetMediaPool()
local files={}; for l in io.lines(arg[2]) do if l~='' then files[#files+1]=l end end
local bin=mp:AddSubFolder(mp:GetRootFolder(),'probe bin'); mp:SetCurrentFolder(bin)
local items=mp:ImportMedia(files); print('imported', #(items or {}), 'of', #files)
local other=mp:AddSubFolder(mp:GetRootFolder(),'probe timelines'); mp:SetCurrentFolder(other)
local tl=mp:ImportTimelineFromFile(arg[1],{timelineName='probe link',importSourceClips=false,sourceClipsFolders={bin}})
print('timeline', tl and tl:GetName())
if tl then local n,linked=0,0; for t=1,tl:GetTrackCount('video') do for _,it in ipairs(tl:GetItemListInTrack('video',t) or {}) do n=n+1; local m=it:GetMediaPoolItem(); if m and (m:GetClipProperty('File Path') or '')~='' then linked=linked+1 end end end
  print('video items', n, 'linked', linked, 'clips in timeline bin', #(other:GetClipList() or {}), 'in media bin', #(bin:GetClipList() or {})) end
