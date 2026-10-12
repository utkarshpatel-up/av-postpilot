-- Dev: empty timeline arg[1]: Text+ title at 0, then a Solid Color generator right after it.
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject(); local mp = p:GetMediaPool()
local tl = mp:CreateEmptyTimeline(arg[1]); p:SetCurrentTimeline(tl); r:OpenPage('edit')
local t = tl:InsertFusionTitleIntoTimeline('Text+')
print('title', t:GetStart() - tl:GetStartFrame(), t:GetDuration())
local fps = math.floor(tonumber(tl:GetSetting('timelineFrameRate')) + 0.5)
local f = t:GetEnd()
print('seek', tl:SetCurrentTimecode(string.format('%02d:%02d:%02d:%02d', math.floor(f/(fps*3600)), math.floor(f/(fps*60))%60, math.floor(f/fps)%60, f%fps)), tl:GetCurrentTimecode())
local g = tl:InsertGeneratorIntoTimeline('Solid Color')
print('black', g and g:GetName(), g and (g:GetStart() - tl:GetStartFrame()), g and g:GetDuration())
for _, it in ipairs(tl:GetItemListInTrack('video', 1)) do print('V1', it:GetStart() - tl:GetStartFrame(), it:GetDuration(), it:GetName()) end
