-- Test helper: open (or create) "PostPilot Test" in the local library.
-- With arg "change": adds an empty timeline so the project content changes.
local r = bmd.scriptapp('Resolve', 'localhost')
local pm = r:GetProjectManager()
local p = pm:LoadProject('PostPilot Test') or pm:CreateProject('PostPilot Test')
print('project: ' .. tostring(p and p:GetName()))
if arg and arg[1] == 'change' then
  local mp = p:GetMediaPool()
  local tl = mp:CreateEmptyTimeline('TL ' .. os.time())
  print('added timeline: ' .. tostring(tl and tl:GetName()))
  pm:SaveProject()
end
