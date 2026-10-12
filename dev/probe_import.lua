local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
print('project', p:GetName(), p:GetSetting('timelineFrameRate'), p:GetSetting('timelineResolutionWidth'))
local tl = p:GetCurrentTimeline(); print('timeline', tl:GetName(), 'start', tl:GetStartFrame(), 'end', tl:GetEndFrame())
for t=1,tl:GetTrackCount('video') do print('V'..t, #(tl:GetItemListInTrack('video',t) or {})) end
for t=1,tl:GetTrackCount('video') do for _,it in ipairs(tl:GetItemListInTrack('video',t) or {}) do
  for f,m in pairs(it:GetMarkers() or {}) do print('marker V'..t, it:GetStart()-tl:GetStartFrame(), it:GetName(), m.color, m.name, m.note) end end end
local paths = {}
for t=1,tl:GetTrackCount('video') do for _,it in ipairs(tl:GetItemListInTrack('video',t) or {}) do local m=it:GetMediaPoolItem(); if m then paths[m:GetClipProperty('File Path')]=true end end end
for k in pairs(paths) do print('file', k) end
