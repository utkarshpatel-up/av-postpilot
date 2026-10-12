-- Dev: set the title's Size arg[2], LineSpacing arg[3], Center y arg[4] (+ text arg[5]) on timeline arg[1].
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl
for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i); if x:GetName()==arg[1] then tl=x end end
p:SetCurrentTimeline(tl)
local it = tl:GetItemListInTrack('video',1)[1]
local c = it:GetFusionCompByIndex(it:GetFusionCompCount())
local t = c:FindTool('PostPilotTitle1')
t:SetInput('Size', tonumber(arg[2])); t:SetInput('LineSpacing', tonumber(arg[3])); t:SetInput('LineSpacingClone', tonumber(arg[3]))
t:SetInput('Center', {0.4979, tonumber(arg[4])})
if arg[5] then t:SetInput('StyledText', (arg[5]:gsub('\\n', '\n'))) end
print('set', t:GetInput('Size'), t:GetInput('LineSpacing'), t:GetInput('LineSpacingClone'))
