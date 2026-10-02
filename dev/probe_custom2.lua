local p = bmd.scriptapp('Resolve', 'localhost'):GetProjectManager():GetCurrentProject()
local list = p:GetRenderPresetList() or {}
local keys = {}
for k, v in pairs(list) do keys[#keys + 1] = k end
table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
local n = 0
for k, v in pairs(list) do n = n + 1 end
print('entries via pairs', n, 'length operator', #list)
local idx = {}
for k in pairs(list) do if type(k) == 'number' then idx[#idx + 1] = k end end
table.sort(idx)
for _, k in ipairs(idx) do if k >= 19 then print(k, list[k]) end end
