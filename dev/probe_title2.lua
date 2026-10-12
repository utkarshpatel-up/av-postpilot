-- Dev: Text+ (own 3840x2160 canvas) straight into MediaOut on V1 clip 1 of timeline arg[1].
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl
for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i); if x:GetName()==arg[1] then tl=x end end
p:SetCurrentTimeline(tl); r:OpenPage('edit')
local it = tl:GetItemListInTrack('video',1)[1]
local comp = it:GetFusionCompByIndex(1)
comp:Lock()
local text = comp:FindTool('PostPilotTitle1')
text:SetInput('UseFrameFormatSettings', 0)
text:SetInput('Width', 3840); text:SetInput('Height', 2160)
text:SetInput('Size', tonumber(arg[3] or '0.1'))
comp:GetToolList(false, 'MediaOut')[1].Input = text.Output
comp:Unlock()
local mi = comp:GetToolList(false, 'MediaIn')[1]
print('mediain attrs', mi:GetAttrs().TOOLIT_Clip_Name and mi:GetAttrs().TOOLIT_Clip_Name[1] or '?')
tl:SetCurrentTimecode('00:00:01:00'); bmd.wait(1); tl:SetCurrentTimecode(arg[4] or '00:00:02:05'); bmd.wait(2)
print('still', p:ExportCurrentFrameAsStill(arg[2]))
