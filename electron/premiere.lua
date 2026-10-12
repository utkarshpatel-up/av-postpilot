-- Premiere import: bring Premiere's XML into the open project, then mark what didn't transfer.
return function(connect, array)
  local function project()
    local r=assert(connect(),'Resolve is not connected');local p=assert(r:GetProjectManager():GetCurrentProject(),'Open a project in Resolve first')
    return r,p
  end
  local function findTimeline(p,id)
    for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i);if x:GetUniqueId()==id then return x end end
  end
  local function bin(mp,names)
    local f=mp:GetRootFolder()
    for _,n in ipairs(names) do local found
      for _,s in ipairs(f:GetSubFolderList() or {}) do if s:GetName()==n then found=s end end
      f=found or assert(mp:AddSubFolder(f,n),'Could not create bin '..n)
    end
    return f
  end
  local function seek(tl,frame)
    local fps=tonumber(tl:GetSetting('timelineFrameRate'));fps=math.floor(fps+0.5)
    return tl:SetCurrentTimecode(string.format('%02d:%02d:%02d:%02d',math.floor(frame/(fps*3600)),math.floor(frame/(fps*60))%60,math.floor(frame/fps)%60,frame%fps))
  end
  -- Clip on a video track starting at a frame counted from the timeline start (1 frame slack).
  local function itemAt(tl,track,start)
    local abs=tl:GetStartFrame()+start
    for _,it in ipairs(tl:GetItemListInTrack('video',track) or {}) do if math.abs(it:GetStart()-abs)<=1 then return it end end
  end
  local function offline(it)
    -- No media pool clip behind it: its file could not be imported (missing), so it is offline.
    local m=it:GetMediaPoolItem();if not m then return true end
    local path=m:GetClipProperty('File Path');if not path or path=='' then return false end
    local st=m:GetClipProperty('Online Status') or m:GetClipProperty('Clip Status')
    return st=='Offline'
  end
  return function(a)
    if a.action=='project' then
      -- Resolve project for this Premiere project: open it if it exists, otherwise create it
      -- with the sequence's frame rate and size (only possible before any timeline exists).
      local r=assert(connect(),'Resolve is not connected');local pm=r:GetProjectManager()
      local cur=pm:GetCurrentProject()
      local p=cur
      if not (cur and cur:GetName()==a.name) then
        -- Save the open project first, except Resolve's unnamed one (saving it pops up a name box).
        if cur and not cur:GetName():match('^Untitled Project') then assert(pm:SaveProject(),'Resolve could not save the open project "'..cur:GetName()..'"') end
        p=pm:LoadProject(a.name)
        if not p then
          p=assert(pm:CreateProject(a.name),'Could not create the Resolve project "'..a.name..'"')
          if a.width and a.width>0 then p:SetSetting('timelineResolutionWidth',tostring(a.width));p:SetSetting('timelineResolutionHeight',tostring(a.height)) end
          if a.fps then p:SetSetting('timelineFrameRate',tostring(a.fps)) end
          pm:SaveProject()
        end
      end
      return {ok=true,project=p:GetName(),fps=p:GetSetting('timelineFrameRate'),width=p:GetSetting('timelineResolutionWidth'),height=p:GetSetting('timelineResolutionHeight')}
    elseif a.action=='bins' then
      -- Premiere's bins with their media, under a.base ({} = the Master bin). Files already in a
      -- bin are skipped, so running it again only adds what is new.
      local r,p=project();local mp=p:GetMediaPool()
      local imported,failed,skipped=0,array(),0
      for _,b in ipairs(a.bins or {}) do
        local path={};for _,x in ipairs(a.base or {}) do path[#path+1]=x end;for _,x in ipairs(b.path or {}) do path[#path+1]=x end
        local folder=bin(mp,path)
        local have={};for _,c in ipairs(folder:GetClipList() or {}) do have[string.lower(c:GetClipProperty('File Path') or '')]=true end
        local todo={};for _,f in ipairs(b.files or {}) do if have[string.lower(f)] then skipped=skipped+1 else todo[#todo+1]=f end end
        if #todo>0 then
          mp:SetCurrentFolder(folder)
          local got={};for _,c in ipairs(mp:ImportMedia(todo) or {}) do got[string.lower(c:GetClipProperty('File Path') or '')]=true;imported=imported+1 end
          for _,f in ipairs(todo) do if not got[string.lower(f)] then failed[#failed+1]=f end end
        end
      end
      r:GetProjectManager():SaveProject()
      return {ok=true,imported=imported,skipped=skipped,failed=failed}
    elseif a.action=='import' then
      local r,p=project();local mp=p:GetMediaPool()
      for i=1,p:GetTimelineCount() do assert(p:GetTimelineByIndex(i):GetName()~=a.name,'A timeline called "'..a.name..'" already exists in this project') end
      -- Frame rate: an empty project is set to the sequence's; otherwise it has to match already.
      local fps=tonumber(p:GetSetting('timelineFrameRate'))
      if a.fps and math.abs((fps or 0)-a.fps)>0.01 then
        assert(p:GetTimelineCount()==0,string.format('This project runs at %s fps, the Premiere sequence at %s fps. Import into a %s fps project.',tostring(fps),tostring(a.fps),tostring(a.fps)))
        p:SetSetting('timelineFrameRate',tostring(a.fps))
        if a.width and a.width>0 then p:SetSetting('timelineResolutionWidth',tostring(a.width));p:SetSetting('timelineResolutionHeight',tostring(a.height)) end
        assert(math.abs(tonumber(p:GetSetting('timelineFrameRate'))-a.fps)<0.01,'Could not set the project to '..a.fps..' fps; set it in Project Settings first')
      end
      local opts={timelineName=a.name,importSourceClips=true}
      if a.sourceBins then
        -- Link to the media already in Premiere's bins instead of importing it again.
        local folders={};for _,sb in ipairs(a.sourceBins) do folders[#folders+1]=bin(mp,sb) end
        opts={timelineName=a.name,importSourceClips=false,sourceClipsFolders=folders}
      end
      mp:SetCurrentFolder(bin(mp,a.binPath or {'Premiere Import',a.bin}))
      local tl=assert(mp:ImportTimelineFromFile(a.xml,opts),'Resolve could not import the XML for '..a.name)
      p:SetCurrentTimeline(tl)
      local tracks=array();local missing=0;local items=0
      for t=1,tl:GetTrackCount('video') do local list=array()
        for _,it in ipairs(tl:GetItemListInTrack('video',t) or {}) do
          local off=offline(it);if off then missing=missing+1 end;items=items+1
          list[#list+1]={start=it:GetStart()-tl:GetStartFrame(),frames=it:GetDuration(),name=it:GetName() or '',offline=off}
        end
        tracks[#tracks+1]=list
      end
      local audio=0;for t=1,tl:GetTrackCount('audio') do audio=audio+#(tl:GetItemListInTrack('audio',t) or {}) end
      r:GetProjectManager():SaveProject()
      return {ok=true,timelineId=tl:GetUniqueId(),name=tl:GetName(),tracks=tracks,videoItems=items,audioItems=audio,offline=missing,fps=tl:GetSetting('timelineFrameRate')}
    elseif a.action=='mark' then
      -- Clip markers at the start of each clip that needs attention.
      local r,p=project();local tl=assert(findTimeline(p,a.timeline),'Imported timeline not found')
      local placed,lost=0,array()
      for _,m in ipairs(a.marks or {}) do local it=itemAt(tl,m.track,m.start)
        if it and it:AddMarker(it:GetLeftOffset(),m.color,m.name,m.note,1,'postpilot-premiere') then placed=placed+1
        -- No clip there (a Premiere title is not imported): mark the timeline at that time instead.
        elseif tl:AddMarker(m.start,m.color,m.name,m.note,math.max(1,(m.frames or 1)),'postpilot-premiere') then placed=placed+1
        else lost[#lost+1]=m.start end
      end
      r:GetProjectManager():SaveProject()
      return {ok=true,placed=placed,lost=lost}
    elseif a.action=='titles' then
      -- Premiere titles: a Text+ per text layer inside the placeholder clip, over its (transparent) picture.
      -- Same order as stabilization: playhead on the clip, Fusion page, tools wired with ConnectInput.
      local r,p=project();local tl=assert(findTimeline(p,a.timeline),'Imported timeline not found');assert(p:SetCurrentTimeline(tl))
      local made,lost=0,array()
      for _,t in ipairs(a.titles or {}) do
        local it=itemAt(tl,t.track,t.start)
        if not it then lost[#lost+1]=t.start else
          r:OpenPage('edit');seek(tl,tl:GetStartFrame()+t.start+math.min(2,math.max(0,it:GetDuration()-1)))
          local c=it:GetFusionCompCount()>0 and it:GetFusionCompByIndex(1) or it:AddFusionComp()
          if not c then lost[#lost+1]=t.start else
            r:OpenPage('fusion')
            -- Rebuilding (e.g. one Text+ per line after measuring): remove the previous title tools.
            for i=1,40 do for _,n in ipairs({'PremiereTitle'..i,'PremiereTitleMerge'..i}) do local old=c:FindTool(n);if old then old:Delete() end end end
            local mi,mo
            for _,tool in pairs(c:GetToolList()) do local id=tool:GetAttrs().TOOLS_RegID;if id=='MediaIn' then mi=tool elseif id=='MediaOut' then mo=tool end end
            local base=mi
            for i,l in ipairs(t.layers or {}) do
              local tx=c:AddTool('TextPlus',i,0);tx:SetAttrs({TOOLS_Name='PremiereTitle'..i})
              tx:SetInput('StyledText',l.text);tx:SetInput('Font',l.font);tx:SetInput('Style',l.style)
              tx:SetInput('Size',l.size);tx:SetInput('LineSpacing',l.lineSpacing);tx:SetInput('CharacterSpacing',l.tracking)
              tx:SetInput('Center',{l.cx,l.cy})
              tx:SetInput('Red1',l.r);tx:SetInput('Green1',l.g);tx:SetInput('Blue1',l.b);tx:SetInput('Alpha1',l.alpha)
              local m=c:AddTool('Merge',i,1);m:SetAttrs({TOOLS_Name='PremiereTitleMerge'..i})
              m:ConnectInput('Background',base);m:ConnectInput('Foreground',tx);base=m
            end
            mo:ConnectInput('Input',base)
            made=made+1
          end
        end
      end
      r:OpenPage('edit');r:GetProjectManager():SaveProject()
      return {ok=true,made=made,lost=lost}
    elseif a.action=='titleframe' or a.action=='titleset' then
      -- Measuring a rebuilt title: 'titleset' changes its Text+ settings; 'titleframe' renders one
      -- frame of it as PNG with the text white and the other video tracks off (then restores both).
      local r,p=project();local tl=assert(findTimeline(p,a.timeline),'Imported timeline not found')
      local it=assert(itemAt(tl,a.track,a.start),'Title clip not found')
      local c=assert(it:GetFusionCompCount()>0 and it:GetFusionCompByIndex(it:GetFusionCompCount()),'Title has no Fusion composition')
      local tools={};for i=1,20 do local t=c:FindTool('PremiereTitle'..i);if not t then break end;tools[i]=t end
      if a.action=='titleset' then
        for _,l in ipairs(a.layers or {}) do local t=tools[l.index]
          if t then
            if l.size then t:SetInput('Size',l.size) end
            if l.lineSpacing then t:SetInput('LineSpacing',l.lineSpacing) end
            if l.cx then t:SetInput('Center',{l.cx,l.cy}) end
            if l.r then t:SetInput('Red1',l.r);t:SetInput('Green1',l.g);t:SetInput('Blue1',l.b) end
          end
        end
        r:GetProjectManager():SaveProject()
        return {ok=true,layers=#tools}
      end
      -- Track on/off is only reported correctly for the current timeline.
      r:OpenPage('edit');assert(p:SetCurrentTimeline(tl),'Could not open '..tl:GetName())
      local saved={};for i,t in ipairs(tools) do saved[i]={t:GetInput('Red1'),t:GetInput('Green1'),t:GetInput('Blue1'),t:GetInput('Alpha1')};t:SetInput('Red1',1);t:SetInput('Green1',1);t:SetInput('Blue1',1);t:SetInput('Alpha1',1) end
      local off={};for i=1,tl:GetTrackCount('video') do if i~=a.track and tl:GetIsTrackEnabled('video',i) then tl:SetTrackEnable('video',i,false);off[#off+1]=i end end
      local ok,err=pcall(function()
        r:OpenPage('deliver')
        p:SetCurrentRenderFormatAndCodec('png','RGB8')
        local f=tl:GetStartFrame()+a.start+(a.frame or 0)
        assert(p:SetRenderSettings({SelectAllFrames=false,MarkIn=f,MarkOut=f,TargetDir=a.dir,CustomName=a.name,ExportVideo=true,ExportAudio=false}),'Render settings refused')
        local id=assert(p:AddRenderJob(),'Could not add the render job');assert(p:StartRendering(id),'Could not start rendering')
        local t0=os.time();repeat bmd.wait(0.5) until not p:IsRenderingInProgress() or os.time()-t0>120
        local st=p:GetRenderJobStatus(id);p:DeleteRenderJob(id)
        assert(st and st.JobStatus=='Complete','Render did not complete')
      end)
      -- Back on the Edit page before restoring: track switches made on the Deliver page don't stick.
      r:OpenPage('edit')
      local stuck={}
      for _,i in ipairs(off) do
        for _=1,5 do tl:SetTrackEnable('video',i,true);if tl:GetIsTrackEnabled('video',i) then break end;bmd.wait(0.3) end
        if not tl:GetIsTrackEnabled('video',i) then stuck[#stuck+1]='V'..i end
      end
      for i,t in ipairs(tools) do local s=saved[i];t:SetInput('Red1',s[1]);t:SetInput('Green1',s[2]);t:SetInput('Blue1',s[3]);t:SetInput('Alpha1',s[4]) end
      assert(#stuck==0,'Could not switch '..table.concat(stuck,', ')..' back on: switch it on by hand in '..tl:GetName())
      assert(ok,err)
      return {ok=true}
    elseif a.action=='goto' then
      local r,p=project();local tl=assert(findTimeline(p,a.timeline),'Timeline not found (deleted or renamed?)');assert(p:SetCurrentTimeline(tl))
      r:OpenPage('edit');seek(tl,tl:GetStartFrame()+a.start+1);return {ok=true}
    elseif a.action=='copygrade' then
      -- Copy the grade of one clip onto the other clips of the same look.
      local r,p=project();local tl=assert(findTimeline(p,a.timeline),'Timeline not found (deleted or renamed?)')
      local src=assert(itemAt(tl,a.from.track,a.from.start),'The source clip was moved; nothing copied')
      local dst={};local lost=0
      for _,d in ipairs(a.to or {}) do local it=itemAt(tl,d.track,d.start);if it then dst[#dst+1]=it else lost=lost+1 end end
      assert(#dst>0,'None of the other clips were found')
      assert(src:CopyGrades(dst),'Resolve could not copy the grade')
      r:GetProjectManager():SaveProject()
      return {ok=true,copied=#dst,lost=lost}
    end
    return {ok=false,error='Unknown premiere action'}
  end
end
