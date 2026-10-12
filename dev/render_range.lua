-- Dev: render frames arg[2]..arg[3] (from timeline start) of timeline arg[1] as H.264 to arg[4]\arg[5].mp4
local ok,err=pcall(function()
local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
local tl
for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i); if x:GetName()==arg[1] then tl=x end end
p:SetCurrentTimeline(tl); r:OpenPage('deliver')
p:SetCurrentRenderFormatAndCodec('mp4','H264')
local s=tl:GetStartFrame()
p:SetRenderSettings({SelectAllFrames=false,MarkIn=s+tonumber(arg[2]),MarkOut=s+tonumber(arg[3]),TargetDir=arg[4],CustomName=arg[5],ExportVideo=true,ExportAudio=false})
local id=p:AddRenderJob(); p:StartRendering(id)
local t0=os.time(); repeat bmd.wait(1) until not p:IsRenderingInProgress() or os.time()-t0>300
print('rendered',os.time()-t0,'s', p:GetRenderJobStatus(id).JobStatus); p:DeleteRenderJob(id); r:OpenPage('edit')
end) print(ok,err)
