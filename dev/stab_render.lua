local ok,err=pcall(function()
local r = bmd.scriptapp('Resolve', 'localhost')
local p = r:GetProjectManager():GetCurrentProject()
local tl=p:GetCurrentTimeline(); r:OpenPage('deliver')
local it=tl:GetItemListInTrack('video',1)[tonumber(arg and arg[1]) or 4]
p:SetCurrentRenderFormatAndCodec('mp4','H264')
p:SetRenderSettings({SelectAllFrames=false,MarkIn=it:GetStart(),MarkOut=it:GetEnd()-1,TargetDir=[[C:\Users\admin\Downloads\av-postpilot\dev\stab_out]],CustomName=''..(arg and arg[2] or 'out')..'',ExportVideo=true,ExportAudio=false,VideoQuality=80000})
local id=p:AddRenderJob(); p:StartRendering(id)
local t0=os.time(); repeat bmd.wait(2) until not p:IsRenderingInProgress() or os.time()-t0>900
print('rendered',os.time()-t0,'s', p:GetRenderJobStatus(id).JobStatus); p:DeleteRenderJob(id)
end) print(ok,err)
