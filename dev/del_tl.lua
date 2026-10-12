local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
for i=p:GetTimelineCount(),1,-1 do local tl=p:GetTimelineByIndex(i); if tl:GetName()==arg[1] then print('deleted', tl:GetName(), p:GetMediaPool():DeleteTimelines({tl})) end end
