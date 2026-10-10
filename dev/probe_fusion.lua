-- List Fusion comps and their tools for marked clips on a timeline (by name, arg[1])
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i) if tl:GetName()==arg[1] then
  for tr=1,tl:GetTrackCount('video') do for idx,it in ipairs(tl:GetItemListInTrack('video',tr)) do local n=it:GetFusionCompCount()
    if n>0 then local s=tr..':'..idx..' '..it:GetName()..' comps='..n
      for c=1,n do local comp=it:GetFusionCompByIndex(c); s=s..' ['..c..':'; for _,t in pairs(comp:GetToolList()) do s=s..t:GetAttrs().TOOLS_RegID..' ' end; s=s..']' end
      print(s) end end end end end
