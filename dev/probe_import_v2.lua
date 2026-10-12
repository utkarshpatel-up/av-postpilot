local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i); if tl:GetName()==arg[1] then
  for t=1,tl:GetTrackCount('video') do for _,it in ipairs(tl:GetItemListInTrack('video',t) or {}) do local m=it:GetMediaPoolItem()
    print('V'..t, it:GetStart()-tl:GetStartFrame(), it:GetName(), m and m:GetClipProperty('File Path'), m and m:GetClipProperty('Online Status'), m and m:GetClipProperty('Clip Status')) end end end end
