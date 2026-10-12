local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i); if tl:GetName()==arg[1] then
  for t=1,tl:GetTrackCount('video') do print('V'..t, 'enabled', tl:GetIsTrackEnabled('video',t)) end
  local it=tl:GetItemListInTrack('video',1)[1]; print('item', it:GetName(), 'enabled', it:GetClipEnabled(), 'opacity', it:GetProperty('Opacity'), 'pool', it:GetMediaPoolItem() and it:GetMediaPoolItem():GetClipProperty('File Path')) end end
