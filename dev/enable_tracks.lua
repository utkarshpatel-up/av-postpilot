-- Dev: switch every video track of timeline arg[1] on (repairs a test timeline).
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject(); r:OpenPage('edit')
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i); if tl:GetName()==arg[1] then p:SetCurrentTimeline(tl)
  for t=1,tl:GetTrackCount('video') do tl:SetTrackEnable('video',t,true); print('V'..t, tl:GetIsTrackEnabled('video',t)) end end end
