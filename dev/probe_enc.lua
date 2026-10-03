local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local mp = p:GetMediaPool()
print('project fps', p:GetSetting('timelineFrameRate'), p:GetSetting('timelineResolutionWidth'))
local folder = mp:AddSubFolder(mp:GetRootFolder(), 'PP enc probe ' .. os.time())
mp:SetCurrentFolder(folder)
local items = mp:ImportMedia({ [[C:\Users\admin\Downloads\av-postpilot\dev\enc_src\clip30.mp4]], [[C:\Users\admin\Downloads\av-postpilot\dev\enc_src\clip25.mp4]] })
local ids = {}
for _, it in ipairs(items) do
  local fps = it:GetClipProperty('FPS'); local res = it:GetClipProperty('Resolution')
  local w, h = string.match(res, '(%d+)x(%d+)')
  local tl = mp:CreateEmptyTimeline('PP enc ' .. it:GetName())
  print(it:GetName(), fps, res, 'custom', tl:SetSetting('useCustomSettings', '1'),
        'fps', tl:SetSetting('timelineFrameRate', tostring(fps)),
        'w', tl:SetSetting('timelineResolutionWidth', w), 'h', tl:SetSetting('timelineResolutionHeight', h))
  print('  timeline now', tl:GetSetting('timelineFrameRate'), tl:GetSetting('timelineResolutionWidth'))
  p:SetCurrentTimeline(tl)
  print('  append', #(mp:AppendToTimeline({ it }) or {}))
  p:LoadRenderPreset('YouTube - 720p'); p:LoadRenderPreset('H.264 Master'); p:SetCurrentRenderMode(1)
  p:SetRenderSettings({ SelectAllFrames = true, TargetDir = [[C:\Users\admin\Downloads\av-postpilot\dev\enc_out]], CustomName = 'out_' .. it:GetName():gsub('%.mp4', '') })
  ids[#ids + 1] = p:AddRenderJob()
end
p:StartRendering(ids, false)
while p:IsRenderingInProgress() do bmd.wait(0.5) end
print('FOLDER', folder:GetName())
