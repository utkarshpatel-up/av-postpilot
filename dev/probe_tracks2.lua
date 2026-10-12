local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject(); r:OpenPage('edit')
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i); if tl:GetName()==arg[1] then
  local a={};for t=1,tl:GetTrackCount('video') do a[#a+1]=tostring(tl:GetIsTrackEnabled('video',t)) end
  p:SetCurrentTimeline(tl); local b={};for t=1,tl:GetTrackCount('video') do b[#b+1]=tostring(tl:GetIsTrackEnabled('video',t)) end
  print(arg[1], 'not current:', table.concat(a,','), ' current:', table.concat(b,',')) end end
