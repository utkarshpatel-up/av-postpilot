local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local tl
for i = 1, p:GetTimelineCount() do local t = p:GetTimelineByIndex(i); if t:GetName() == 'PP HD temp' then tl = t end end
p:SetCurrentTimeline(tl)
for _, preset in ipairs({ 'YouTube - 720p', 'H.264 Master', 'ProRes 422 HQ' }) do
  p:LoadRenderPreset(preset)
  for _, v in ipairs({ 0, 2, '0', 'Individual clips' }) do
    local ok = p:SetCurrentRenderMode(v)
    print(preset, 'value', tostring(v), 'returned', tostring(ok), 'mode', p:GetCurrentRenderMode())
  end
  p:SetCurrentRenderMode(1)
end
local f = p:GetCurrentRenderFormatAndCodec(); print('fmt', f.format, f.codec)
