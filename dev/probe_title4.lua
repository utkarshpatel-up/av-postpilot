-- Dev: like stabilization: seek to V1 clip arg[2] of timeline arg[1], Fusion page, Text+ over MediaIn.
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl
for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i); if x:GetName()==arg[1] then tl=x end end
p:SetCurrentTimeline(tl); r:OpenPage('edit')
local it = tl:GetItemListInTrack('video',1)[tonumber(arg[2])]
for _, n in pairs(it:GetFusionCompNameList() or {}) do print('delete old', n, it:DeleteFusionCompByName(n)) end
local f = it:GetStart() + 10; local fps = 25
print('seek', tl:SetCurrentTimecode(string.format('%02d:%02d:%02d:%02d', math.floor(f/(fps*3600)), math.floor(f/(fps*60))%60, math.floor(f/fps)%60, f%fps)))
local c = assert(it:AddFusionComp())
r:OpenPage('fusion')
local mi, mo
for _, t in pairs(c:GetToolList()) do local id = t:GetAttrs().TOOLS_RegID; if id == 'MediaIn' then mi = t elseif id == 'MediaOut' then mo = t end end
local text = assert(c:AddTool('TextPlus', 1, 0)); text:SetAttrs({TOOLS_Name='PostPilotTitle1'})
text:SetInput('StyledText', arg[3] or 'DD Vitrag - 8403\n(Adalaj)')
text:SetInput('Font', 'Calibri'); text:SetInput('Style', 'Bold')
text:SetInput('Size', tonumber(arg[4] or '0.1'))
text:SetInput('Center', {0.4979, tonumber(arg[5] or '0.4634')})
local merge = assert(c:AddTool('Merge', 2, 0)); merge:SetAttrs({TOOLS_Name='PostPilotTitleMerge'})
merge:ConnectInput('Background', mi); merge:ConnectInput('Foreground', text); mo:ConnectInput('Input', merge)
r:OpenPage('edit')
print('done', it:GetFusionCompCount())
