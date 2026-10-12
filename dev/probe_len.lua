-- Dev: can a script change an inserted title's length? Tries the API calls that might exist.
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject(); local mp = p:GetMediaPool()
local tl = mp:CreateEmptyTimeline('probe length'); p:SetCurrentTimeline(tl); r:OpenPage('edit')
local t = tl:InsertFusionTitleIntoTimeline('Text+')
print('title', t:GetStart() - tl:GetStartFrame(), t:GetDuration())
for _, name in ipairs({'SetEnd', 'SetDuration', 'SetStart', 'SetLeftOffset', 'SetRightOffset', 'SetProperty'}) do
  local ok, res = pcall(function() return t[name] end)
  print(name, ok and type(res) or ('error ' .. tostring(res)))
end
local ok, res = pcall(function() return t:SetProperty('Duration', 750) end); print('SetProperty Duration', ok, res, t:GetDuration())
ok, res = pcall(function() return t:SetEnd(t:GetStart() + 750) end); print('SetEnd', ok, res, t:GetDuration())
