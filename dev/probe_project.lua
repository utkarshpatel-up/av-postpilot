local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
print('project', p and p:GetName())
if p then for i=1,p:GetTimelineCount() do print('timeline', p:GetTimelineByIndex(i):GetName()) end end
