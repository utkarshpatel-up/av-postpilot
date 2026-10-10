-- print source info for given track:index keys on a timeline: arg[1]=name, arg[2..]=keys
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i) if tl:GetName()==arg[1] then
  print('fps',tl:GetSetting('timelineFrameRate'),tl:GetSetting('timelineResolutionWidth'),tl:GetSetting('timelineResolutionHeight'))
  for n=2,#arg do local tr,idx=arg[n]:match('(%d+):(%d+)'); local it=tl:GetItemListInTrack('video',tonumber(tr))[tonumber(idx)]
    local m=it:GetMediaPoolItem(); print(arg[n], it:GetLeftOffset(), it:GetDuration(), m:GetClipProperty('File Path'), m:GetClipProperty('Resolution'), m:GetClipProperty('FPS'), 'zoom', it:GetProperty('ZoomX')) end end end
