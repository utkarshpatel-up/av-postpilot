-- Dev: Text+ over MediaIn on V1 clip arg[3] of timeline arg[1]; still at timecode arg[4] to arg[2].
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl
for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i); if x:GetName()==arg[1] then tl=x end end
p:SetCurrentTimeline(tl); r:OpenPage('edit')
local it = tl:GetItemListInTrack('video',1)[tonumber(arg[3])]
print('item', it:GetName(), 'comps', it:GetFusionCompCount())
local comp = it:GetFusionCompCount() > 0 and it:GetFusionCompByIndex(1) or it:AddFusionComp()
comp:Lock()
local text = comp:AddTool('TextPlus', -32768, -32768)
text:SetInput('StyledText', 'TEST TITLE')
text:SetInput('Size', 0.2)
local merge = comp:AddTool('Merge', -32768, -32768)
local mi = comp:GetToolList(false, 'MediaIn')[1]
merge:SetInput('Background', mi); merge:SetInput('Foreground', text)
comp:GetToolList(false, 'MediaOut')[1]:SetInput('Input', merge)
comp:Unlock()
tl:SetCurrentTimecode('00:00:00:10'); bmd.wait(1); tl:SetCurrentTimecode(arg[4]); bmd.wait(2)
print('still', p:ExportCurrentFrameAsStill(arg[2]))
