-- List (arg[1]=='list') or delete stabilized copies and Claude test timelines in the open project
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local doomed, keep = {}, {}
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i); local n=tl:GetName()
  if n:match(' %- PostPilot Stabilized %d%d%d%d%d%d$') or n:match('^Claude ') then doomed[#doomed+1]=tl else keep[#keep+1]=tl end end
print('project', p:GetName()); for _,t in ipairs(doomed) do print('DELETE', t:GetName()) end; for _,t in ipairs(keep) do print('keep', t:GetName()) end
if arg[1]=='delete' and #keep>0 then p:SetCurrentTimeline(keep[1]); print('deleted', p:GetMediaPool():DeleteTimelines(doomed)) end
