-- Dev: list Text+ inputs matching arg[2] on timeline arg[1], V1 clip 1, tool PostPilotTitle1.
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl
for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i); if x:GetName()==arg[1] then tl=x end end
local it = tl:GetItemListInTrack('video',1)[1]
local c = it:GetFusionCompByIndex(it:GetFusionCompCount())
local t = c:FindTool('PostPilotTitle1')
for _, i in pairs(t:GetInputList()) do local id = i:GetAttrs().INPS_ID
  if id:lower():match(arg[2]) then local v = t:GetInput(id); if type(v) == 'table' then v = table.concat(v, ',') end; print(id, tostring(v), i:GetAttrs().INPS_Name) end end
