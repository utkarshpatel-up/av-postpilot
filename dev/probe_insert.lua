-- Dev: replace the placeholder at V1 frame 0 of timeline arg[1] with an inserted Text+.
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl
for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i); if x:GetName()==arg[1] then tl=x end end
p:SetCurrentTimeline(tl); r:OpenPage('edit')
local function dump(tag) for t=1,tl:GetTrackCount('video') do for _,it in ipairs(tl:GetItemListInTrack('video',t) or {}) do
  if it:GetStart()-tl:GetStartFrame() < 200 then print(tag, 'V'..t, it:GetStart()-tl:GetStartFrame(), it:GetDuration(), it:GetName()) end end end end
dump('before')
local ph = tl:GetItemListInTrack('video',1)[1]
print('delete', tl:DeleteClips({ph}, false))
dump('gap')
tl:SetCurrentTimecode(tl:GetStartTimecode())
local t = tl:InsertFusionTitleIntoTimeline('Text+')
print('inserted', t and t:GetName(), t and (t:GetStart()-tl:GetStartFrame()), t and t:GetDuration())
dump('after')
