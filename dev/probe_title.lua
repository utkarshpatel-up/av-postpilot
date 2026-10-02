local r = bmd.scriptapp('Resolve', 'localhost')
local p = r:GetProjectManager():LoadProject('PostPilot Test')
local mp = p:GetMediaPool()
local tl = mp:CreateEmptyTimeline('TitleProbe ' .. os.time())
p:SetCurrentTimeline(tl)
local item = tl:InsertTitleIntoTimeline('Text')
print('inserted:', item and item:GetName())
if item then
  local props = item:GetProperty() or {}
  for k, v in pairs(props) do if type(v) ~= 'table' then print('prop', k, v) end end
  print('fusion comps:', item:GetFusionCompCount())
  for _, k in ipairs({'Text','RichText','StyledText'}) do print('set '..k, item:SetProperty(k, 'HELLO')) end
end
