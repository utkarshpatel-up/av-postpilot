local r = bmd.scriptapp('Resolve', 'localhost')
local p = r:GetProjectManager():GetCurrentProject()
local tl
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName():match('^DD Vitraag%-9002 %(bars') then tl = t end end
print('timeline', tl and tl:GetName())
p:SetCurrentTimeline(tl)
r:OpenPage('color'); bmd.wait(1.5)
tl:SetCurrentTimecode(tl:GetStartTimecode()); bmd.wait(1.5)
print('still', p:ExportCurrentFrameAsStill([[C:\Users\admin\Downloads\av-postpilot\dev\bars_renamed.png]]))
r:OpenPage('edit')
