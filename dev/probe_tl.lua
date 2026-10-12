local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i)
  if tl:GetName()==arg[1] then local n,off,none=0,0,0;local names={}
    for t=1,tl:GetTrackCount('video') do for _,it in ipairs(tl:GetItemListInTrack('video',t) or {}) do n=n+1
      local m=it:GetMediaPoolItem(); if not m then none=none+1; names[it:GetName()]=true elseif (m:GetClipProperty('File Path') or '')=='' then names['nofile:'..it:GetName()]=true end end end
    print(tl:GetName(), 'video items', n, 'no pool item', none); for k in pairs(names) do print(' ', k) end end end
