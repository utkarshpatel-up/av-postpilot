local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local mp = p:GetMediaPool()
local function show(tl, label)
  print(label)
  for track = 1, tl:GetTrackCount('video') do
    for _, it in ipairs(tl:GetItemListInTrack('video', track) or {}) do print('   V' .. track, it:GetName(), it:GetStart(), it:GetEnd()) end
  end
end
for _, n in ipairs({ 'BT.2111 Color Bar HLG Narrow', 'BT.2111 Color Bar PQ Narrow', 'BT.2111 Color Bar HLG Narrow Range' }) do
  local tl = mp:CreateEmptyTimeline('BarsF ' .. os.time() .. n:sub(-6))
  p:SetCurrentTimeline(tl)
  local g = tl:InsertFusionGeneratorIntoTimeline(n)
  print('fusion gen', n, g and g:GetName())
  local okf, g2 = pcall(function() return tl:InsertOFXGeneratorIntoTimeline(n) end)
  print('ofx gen', n, g2 and g2:GetName())
end
-- A: V1 occupied (unlocked), playhead at start, insert title
local tl = mp:CreateEmptyTimeline('BarsA ' .. os.time()); p:SetCurrentTimeline(tl)
tl:InsertGeneratorIntoTimeline('SMPTE Color Bar'); tl:AddTrack('video')
tl:SetCurrentTimecode(tl:GetStartTimecode())
print('A title', tl:InsertFusionTitleIntoTimeline('Text+') and 'ok'); show(tl, 'A')
-- B: V1 disabled
local tl2 = mp:CreateEmptyTimeline('BarsB ' .. os.time()); p:SetCurrentTimeline(tl2)
tl2:InsertGeneratorIntoTimeline('SMPTE Color Bar'); tl2:AddTrack('video')
print('disable V1', tl2:SetTrackEnable('video', 1, false))
tl2:SetCurrentTimecode(tl2:GetStartTimecode())
print('B title', tl2:InsertFusionTitleIntoTimeline('Text+') and 'ok'); tl2:SetTrackEnable('video', 1, true); show(tl2, 'B')
-- C: title first, then generator
local tl3 = mp:CreateEmptyTimeline('BarsC ' .. os.time()); p:SetCurrentTimeline(tl3)
tl3:InsertFusionTitleIntoTimeline('Text+'); tl3:AddTrack('video')
tl3:SetCurrentTimecode(tl3:GetStartTimecode())
print('C gen', tl3:InsertGeneratorIntoTimeline('SMPTE Color Bar') and 'ok'); show(tl3, 'C')
