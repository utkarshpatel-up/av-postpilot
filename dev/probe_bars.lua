local r = bmd.scriptapp('Resolve', 'localhost')
local p = r:GetProjectManager():GetCurrentProject()
local mp = p:GetMediaPool()
local tl = mp:CreateEmptyTimeline('BarsProbe ' .. os.time())
p:SetCurrentTimeline(tl)
local gen = tl:InsertGeneratorIntoTimeline('BT.2111 Color Bar HLG Narrow')
print('generator', gen and gen:GetName(), gen and gen:GetStart(), gen and gen:GetEnd(), 'tracks', tl:GetTrackCount('video'))
if not gen then
  for _, n in ipairs({ 'SMPTE Color Bar', 'EBU Color Bar', '100mV Steps', 'Color Bars' }) do
    local g = tl:InsertGeneratorIntoTimeline(n); print('try', n, g and g:GetName())
    if g then gen = g; break end
  end
end
print('add track', tl:AddTrack('video'))
print('lock V1', tl:SetTrackLock('video', 1, true))
tl:SetCurrentTimecode(tl:GetStartTimecode())
local t = tl:InsertFusionTitleIntoTimeline('Text+')
print('title', t and t:GetName(), t and t:GetStart(), t and t:GetEnd())
tl:SetTrackLock('video', 1, false)
for track = 1, tl:GetTrackCount('video') do
  for _, it in ipairs(tl:GetItemListInTrack('video', track) or {}) do print('  V' .. track, it:GetName(), it:GetStart(), it:GetEnd()) end
end
