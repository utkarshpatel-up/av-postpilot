local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject(); local mp=p:GetMediaPool()
local tl=mp:ImportTimelineFromFile(arg[1],{timelineName=arg[2],importSourceClips=true})
print('timeline', tl and tl:GetName())
if not tl then return end
for t=1,tl:GetTrackCount('video') do for _,it in ipairs(tl:GetItemListInTrack('video',t) or {}) do
  if it:GetStart()-tl:GetStartFrame() < 130 then print('V'..t, it:GetStart()-tl:GetStartFrame(), it:GetDuration(), it:GetName(), 'pool', it:GetMediaPoolItem() and 'yes' or 'no', 'comps', it:GetFusionCompCount()) end end end
