-- Dev: build a Text+ inside the title placeholder (V1, first clip) of timeline arg[1] and save
-- a still of 00:00:02:00 to arg[2]. Size and Center Y from arg[3], arg[4].
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl
for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i); if x:GetName()==arg[1] then tl=x end end
p:SetCurrentTimeline(tl); r:OpenPage('edit')
local it = tl:GetItemListInTrack('video',1)[1]
print('item', it:GetName(), it:GetDuration(), 'comps', it:GetFusionCompCount())
local comp = it:GetFusionCompCount() > 0 and it:GetFusionCompByIndex(1) or it:AddFusionComp()
print('comp', comp ~= nil)
comp:Lock()
local text = comp:FindTool('PostPilotTitle1')
if not text then text = comp:AddTool('TextPlus', -32768, -32768); text:SetAttrs({TOOLS_Name='PostPilotTitle1'}) end
text.StyledText = 'DD Vitrag - 8403\n(Adalaj)'
text:SetInput('Font', 'Calibri'); text:SetInput('Style', 'Bold')
text:SetInput('Size', tonumber(arg[3] or '0.1'))
text:SetInput('Center', {0.4979, tonumber(arg[4] or '0.4634')})
local merge = comp:FindTool('PostPilotMerge1')
if not merge then merge = comp:AddTool('Merge', -32768, -32768); merge:SetAttrs({TOOLS_Name='PostPilotMerge1'}) end
local mediain = comp:GetToolList(false, 'MediaIn')[1]
merge.Background = mediain.Output; merge.Foreground = text.Output
comp:GetToolList(false, 'MediaOut')[1].Input = merge.Output
comp:Unlock()
print('text', text:GetInput('StyledText'), text:GetInput('Font'), text:GetInput('Size'))
tl:SetCurrentTimecode(tl:GetStartTimecode():gsub('%d%d:%d%d$', '02:00'))
print('tc', tl:GetCurrentTimecode())
print('still', p:ExportCurrentFrameAsStill(arg[2]))
