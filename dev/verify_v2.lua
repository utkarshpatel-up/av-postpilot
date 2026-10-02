local r = bmd.scriptapp('Resolve', 'localhost')
local p = r:GetProjectManager():GetCurrentProject()
print('PROJECT', p:GetName(), p:GetSetting('timelineFrameRate'), p:GetSetting('timelineResolutionWidth'))
local function tree(f, ind)
  print(ind .. '[' .. f:GetName() .. '] ' .. #(f:GetClipList() or {}) .. ' item(s)')
  for _, s in ipairs(f:GetSubFolderList() or {}) do tree(s, ind .. '  ') end
end
tree(p:GetMediaPool():GetRootFolder(), '')
for i = 1, p:GetTimelineCount() do
  local t = p:GetTimelineByIndex(i)
  local names = {}
  for _, it in ipairs(t:GetItemListInTrack('video', 1) or {}) do names[#names + 1] = (it:GetName():match('Clip%-%d+') or it:GetName()) .. '@' .. it:GetStart() end
  print('TL', t:GetName(), table.concat(names, ', '))
end
for i = 1, p:GetTimelineCount() do
  local t = p:GetTimelineByIndex(i)
  if t:GetName():match('^DD Hindi%-1750') then
    p:SetCurrentTimeline(t)
    local it = t:GetItemListInTrack('video', 1)[1]
    local tp = it:GetFusionCompByIndex(1):GetToolList(false, 'TextPlus')[1]
    print('TITLE TEXT', tp:GetInput('StyledText'))
    t:SetCurrentTimecode('01:00:01:00')
    print('still', p:ExportCurrentFrameAsStill([[C:\Users\admin\Downloads\av-postpilot\dev\title_check.png]]))
  end
end
