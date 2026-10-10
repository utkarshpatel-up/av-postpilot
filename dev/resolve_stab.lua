-- New timeline with one source range, then Resolve's built-in Stabilize(). arg: start frames name
local ok,err=pcall(function()
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local src; for i=1,p:GetTimelineCount() do local t=p:GetTimelineByIndex(i) if t:GetName()=='Timeline 9' then src=t end end
local mpi=src:GetItemListInTrack('video',1)[1]:GetMediaPoolItem()
local mp=p:GetMediaPool(); local tl=mp:CreateEmptyTimeline(arg[3]..' '..os.date('%H%M%S')); p:SetCurrentTimeline(tl)
local s=tonumber(arg[1]); mp:AppendToTimeline({{mediaPoolItem=mpi,startFrame=s,endFrame=s+tonumber(arg[2])-1,mediaType=1}})
local it=tl:GetItemListInTrack('video',1)[1]
local props=it:GetProperty() or {}; local keys={} for k,v in pairs(props) do if tostring(k):lower():match('stab') then keys[#keys+1]=k..'='..tostring(v) end end
print('stab props:',table.concat(keys,' '))
r:OpenPage('color'); local t0=os.time(); print('Stabilize',it:Stabilize(),os.time()-t0,'s', tl:GetName(), it:GetDuration())
end) print(ok,err)
