local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i); if tl:GetName()==arg[1] then
  print('end', tl:GetEndFrame()-tl:GetStartFrame())
  for t=1,tl:GetTrackCount('video') do local l=tl:GetItemListInTrack('video',t) or {}; for k=1,math.min(4,#l) do local it=l[k]; print('V'..t, it:GetStart()-tl:GetStartFrame(), it:GetDuration(), it:GetName()) end end end end
