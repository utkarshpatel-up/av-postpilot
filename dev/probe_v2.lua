local r = bmd.scriptapp('Resolve', 'localhost')
if not r then print('NOT CONNECTED'); return end
local pm = r:GetProjectManager()
local p = pm:LoadProject('PostPilot Test')
local mp = p:GetMediaPool()
local tl = p:GetCurrentTimeline() or p:GetTimelineByIndex(1)
local function has(obj, name)
  local ok, f = pcall(function() return obj[name] end)
  return ok and f ~= nil
end
for _, n in ipairs({'AddSubFolder','ImportMedia','CreateTimelineFromClips','AppendToTimeline','CreateEmptyTimeline','SetCurrentFolder'}) do print('MediaPool.'..n, has(mp, n)) end
for _, n in ipairs({'DetectSceneCuts','DuplicateTimeline','SetName','InsertTitleIntoTimeline','InsertFusionTitleIntoTimeline','InsertGeneratorIntoTimeline','SetCurrentTimecode','GetItemListInTrack','AddMarker'}) do print('Timeline.'..n, has(tl, n)) end
print('SetCurrentTimeline', has(p, 'SetCurrentTimeline'))
