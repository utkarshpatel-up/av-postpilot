local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
print('project', p:GetName())
local function walk(f, pad)
  local clips = f:GetClipList() or {}; local names = {}
  for _, c in ipairs(clips) do names[#names+1] = c:GetName() .. (c:GetClipProperty('Type') == 'Timeline' and ' [timeline]' or '') end
  print(pad .. f:GetName() .. '  (' .. #clips .. ')  ' .. table.concat(names, ' | '))
  for _, s in ipairs(f:GetSubFolderList() or {}) do walk(s, pad .. '   ') end
end
walk(p:GetMediaPool():GetRootFolder(), '')
