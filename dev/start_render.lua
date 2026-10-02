local p=bmd.scriptapp('Resolve','localhost'):GetProjectManager():GetCurrentProject()
    for i=1,p:GetTimelineCount() do local t=p:GetTimelineByIndex(i); if t:GetName():match('^CutQ') then p:SetCurrentTimeline(t)
      p:SetRenderSettings({TargetDir=[[C:\Users\admin\Downloads\av-postpilot\dev\renders7]], CustomName='EP-8911 Part '..i}); p:AddRenderJob() end end
    p:StartRendering()