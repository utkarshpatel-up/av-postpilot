-- Dev: inspect the title comp on V1 clip 1 of timeline arg[1]; still at timecode arg[3] to arg[2].
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl
for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i); if x:GetName()==arg[1] then tl=x end end
p:SetCurrentTimeline(tl); r:OpenPage('edit')
local it = tl:GetItemListInTrack('video',1)[1]
local comp = it:GetFusionCompByIndex(1)
for name, tool in pairs(comp:GetToolList(false)) do
  local inp = tool:GetInputList(); local con = {}
  for _, i in pairs(inp) do local o = i:GetConnectedOutput(); if o then con[#con+1] = i:GetAttrs().INPS_ID .. '<-' .. o:GetTool():GetAttrs().TOOLS_Name end end
  print('tool', tool:GetAttrs().TOOLS_Name, tool:GetAttrs().TOOLS_RegID, table.concat(con, ' '))
end
print('seek', tl:SetCurrentTimecode(arg[3]), tl:GetCurrentTimecode())
bmd.wait(2)
print('still', p:ExportCurrentFrameAsStill(arg[2]))
