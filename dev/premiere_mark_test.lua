-- Dev: call premiere.lua's mark action on the current project's timeline named arg[1].
local function connect() return bmd.scriptapp('Resolve','localhost') end
local function array(t) return t or {} end
local run = dofile('electron/premiere.lua')(connect, array)
local p = connect():GetProjectManager():GetCurrentProject(); local id
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i); if tl:GetName()==arg[1] then id=tl:GetUniqueId() end end
local r = run({action='mark', timeline=id, marks={{track=1,start=0,frames=125,color='Purple',name='Premiere: Title',note='Title "DD Vitrag - 8403 (Adalaj)" · Calibri-Bold'}}})
print('ok', r.ok, 'placed', r.placed, 'lost', #r.lost)
for t=1,1 do end
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i); if tl:GetName()==arg[1] then for f,m in pairs(tl:GetMarkers() or {}) do print('timeline marker', f, m.color, m.name, m.duration) end end end
