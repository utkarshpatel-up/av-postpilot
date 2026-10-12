-- Dev: append a PNG still (arg[1]) with exact lengths 750 and 75 frames to a test timeline.
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject(); local mp = p:GetMediaPool()
local items = mp:ImportMedia({arg[1]}); local png = items and items[1]
print('png', png and png:GetName(), png and png:GetClipProperty('Frames'), png and png:GetClipProperty('Duration'))
local tl = mp:CreateEmptyTimeline('probe still length'); p:SetCurrentTimeline(tl)
local s = tl:GetStartFrame()
local made = mp:AppendToTimeline({
  {mediaPoolItem = png, startFrame = 0, endFrame = 749, trackIndex = 1, recordFrame = s},
  {mediaPoolItem = png, startFrame = 0, endFrame = 74, trackIndex = 1, recordFrame = s + 750},
})
print('appended', made and #made)
for _, it in ipairs(tl:GetItemListInTrack('video', 1) or {}) do print('V1', it:GetStart() - s, it:GetDuration()) end
