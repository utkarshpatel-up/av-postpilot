local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl=p:GetTimelineByIndex(tonumber(arg[1])); print(p:SetCurrentTimeline(tl), tl:GetName()); r:OpenPage('edit')
