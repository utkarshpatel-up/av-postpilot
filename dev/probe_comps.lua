-- Dev: list Fusion comps on V1 clip 1 of timeline arg[1]; optionally load comp arg[2] by name.
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl
for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i); if x:GetName()==arg[1] then tl=x end end
local it = tl:GetItemListInTrack('video',1)[1]
print('count', it:GetFusionCompCount())
for i, n in pairs(it:GetFusionCompNameList() or {}) do
  local c = it:GetFusionCompByName(n); local tools = {}
  for _, t in pairs(c:GetToolList(false)) do tools[#tools+1] = t:GetAttrs().TOOLS_Name end
  print('comp', i, n, table.concat(tools, ','))
end
if arg[2] then print('load', it:LoadFusionCompByName(arg[2])) end
local t = it:GetFusionCompByIndex(1):FindTool('PostPilotTitle1')
if t then print('color', t:GetInput('Red1'), t:GetInput('Alpha1'), 'enabled', t:GetAttrs().TOOLB_PassThrough) end
