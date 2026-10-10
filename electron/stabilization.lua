-- Native Fusion Tracker batch. All edits are confined to a timeline duplicate.
return function(connect, array)
  local session, active
  local function context(a, duplicate)
    local r=assert(connect(),'Resolve is not connected');local p=assert(r:GetProjectManager():GetCurrentProject(),'Open a project')
    assert(session and p:GetUniqueId()==session.project,'Project changed; scan again')
    local tl=p:GetCurrentTimeline();assert(tl and tl:GetUniqueId()==(duplicate and session.copy or session.timeline),'Timeline changed; return to the scanned timeline')
    return r,p,tl
  end
  local function seek(tl,frame)
    local fps=tonumber(tl:GetSetting('timelineFrameRate'));assert(fps and fps==math.floor(fps),'This preview currently requires a whole-number timeline frame rate')
    assert(tl:SetCurrentTimecode(string.format('%02d:%02d:%02d:%02d',math.floor(frame/(fps*3600)),math.floor(frame/(fps*60))%60,math.floor(frame/fps)%60,frame%fps)))
  end
  return function(a)
    if a.action=='scan' then
      assert(not active,'Finish the current tracker first')
      local r=assert(connect());local p=assert(r:GetProjectManager():GetCurrentProject(),'Open a project');local tl=assert(p:GetCurrentTimeline(),'Open a timeline')
      local colors={};for _,m in pairs(tl:GetMarkers() or {}) do colors[m.color]=true end
      local list=array();for color in pairs(colors) do list[#list+1]=color end;table.sort(list)
      local clips=array();local refs={};local seen={}
      for frame,m in pairs(tl:GetMarkers() or {}) do if not a.color or a.color=='All' or m.color==a.color then
        local absolute=tl:GetStartFrame()+frame;local found=false
        for tr=tl:GetTrackCount('video'),1,-1 do
          for idx,it in ipairs(tl:GetItemListInTrack('video',tr)) do if tl:GetIsTrackEnabled('video',tr) and absolute>=it:GetStart() and absolute<it:GetEnd() and it:GetClipEnabled() then
            local key=tr..':'..idx
            if not seen[key] then
              local row={key=key,track=tr,index=idx,name=it:GetName(),start=it:GetStart(),frames=it:GetEnd()-it:GetStart(),marker=m.name,color=m.color,fusion=it:GetFusionCompCount()}
              clips[#clips+1]=row;refs[key]={item=it,start=row.start,frames=row.frames,track=tr,index=idx};seen[key]=true
            end
            found=true;break
          end end
          if found then break end
        end
      end end
      table.sort(clips,function(x,y)return x.start<y.start end)
      session={project=p:GetUniqueId(),timeline=tl:GetUniqueId(),name=tl:GetName(),refs=refs,owned={},attempts={}};active=nil
      return {ok=true,colors=list,clips=clips,timeline=tl:GetName()}
    elseif a.action=='preview' then
      local r,p,tl=context(a,false);local ref=assert(session.refs[a.key]);local frame=math.max(0,math.min(ref.frames-1,tonumber(a.frame) or 0))
      seek(tl,ref.start+frame);r:OpenPage('color')
      if a.file then
        r:OpenPage('edit');bmd.wait(.3)
        assert(p:ExportCurrentFrameAsStill(a.file),'Resolve could not provide a preview; try again')
        return {ok=true,file=a.file,frame=frame}
      end
      local thumb=tl:GetCurrentClipThumbnailImage();assert(thumb and thumb.data,'Resolve could not provide a preview; try again')
      return {ok=true,thumbnail=thumb,frame=frame}
    elseif a.action=='begin' then
      assert(not active);local r,p,tl=context(a,false);assert(not p:IsRenderingInProgress(),'Wait for rendering to finish');assert(r:GetProjectManager():SaveProject(),'Could not save project')
      local copy=assert(tl:DuplicateTimeline(session.name..' - PostPilot Stabilized '..os.date('%H%M%S')),'Could not duplicate timeline');session.copy=copy:GetUniqueId();assert(p:SetCurrentTimeline(copy))
      return {ok=true,timeline=copy:GetName()}
    elseif a.action=='frame' then
      assert(not active,'Wait for tracking to finish');local r,p,tl=context(a,true);local ref=assert(session.refs[a.key]);local it=assert(tl:GetItemListInTrack('video',ref.track)[ref.index])
      assert(it:GetStart()==ref.start and it:GetEnd()-it:GetStart()==ref.frames,'Clip was edited; scan again')
      local frame=assert(tonumber(a.frame));assert(frame>=0 and frame<ref.frames and frame==math.floor(frame));seek(tl,ref.start+frame);r:OpenPage('edit')
      assert(p:ExportCurrentFrameAsStill(assert(a.file)),'Could not read timeline output for verification');return {ok=true,frame=frame}
    elseif a.action=='track' then
      -- One Tracker tool, one classic point tracker per point (never IntelliTrack: it drifts).
      assert(not active,'Tracking already running');local r,p,tl=context(a,true);local ref=assert(session.refs[a.key]);local it=assert(tl:GetItemListInTrack('video',ref.track)[ref.index]);assert(it:GetStart()==ref.start and it:GetEnd()-it:GetStart()==ref.frames,'Clip was edited; scan again')
      assert(it:GetFusionCompCount()==0,'Clip already has Fusion effects; retained for manual review')
      local pts=assert(a.points);assert(#pts>=1,'No fixed points to track')
      seek(tl,ref.start);local c=assert(it:AddFusionComp());r:OpenPage('fusion');local t=assert(c:AddTool('Tracker',1,0));local mi,mo
      for _,tool in pairs(c:GetToolList()) do local id=tool:GetAttrs().TOOLS_RegID;if id=='MediaIn' then mi=tool elseif id=='MediaOut' then mo=tool end end;assert(mi and mo)
      t:ConnectInput('Input',mi);mo:ConnectInput('Input',t);t:SetInput('Enabled1',0)
      -- Comp frame 0 is the clip's first timeline frame; GlobalStart is the source start.
      local first,last=0,ref.frames-1;local name=t:GetAttrs().TOOLS_Name
      for i,pt in ipairs(pts) do local n=i+1;t:SetInput('AddPointTracker',1)
        t:SetInput('PatternCenter'..n,{pt.x,pt.y},first);t:SetInput('PatternWidth'..n,pt.width or .04,first);t:SetInput('PatternHeight'..n,pt.height or .05,first);t:SetInput('SearchWidth'..n,.08,first);t:SetInput('SearchHeight'..n,.08,first)
      end
      t:SetInput('AdaptiveMode',0,first)
      local s=t:SaveSettings();for i,pt in ipairs(pts) do local tr=s.Tools[name].Trackers[i+1];tr.PatternTime=first;tr.PatternX=pt.x;tr.PatternY=pt.y end;assert(t:LoadSettings(s))
      c:SetAttrs({COMPN_RenderStart=first,COMPN_RenderEnd=last});c.CurrentTime=first
      active={comp=c,tool=t,item=it,first=first,last=last,key=a.key,count=#pts};t:SetInput('TrackForward',1,first)
      return {ok=true,frames=ref.frames}
    elseif a.action=='progress' then
      local r,p,tl=context(a,true);assert(active,'No tracker is running');local c,t=active.comp,active.tool
      if c:IsRendering() then return {ok=true,running=true,percent=math.floor(100*(c.CurrentTime-active.first)/math.max(1,active.last-active.first))} end
      local paths=array()
      for i=1,active.count do local path=array()
        for n=active.first,active.last do local v=t:GetInput('TrackedCenter'..(i+1),n);path[#path+1]=v and v[1] and array({v[1],v[2]}) or array({'nan','nan'}) end
        paths[i]=path
      end
      session.done=session.done or {};session.done[active.key]={comp=c,tool=t,item=active.item,count=active.count};active=nil
      return {ok=true,running=false,paths=paths,width=tonumber(tl:GetSetting('timelineResolutionWidth')),height=tonumber(tl:GetSetting('timelineResolutionHeight'))}
    elseif a.action=='apply' then
      -- Keep only the agreeing points; Match Move averages the enabled trackers.
      assert(not active);local r,p,tl=context(a,true);local d=assert(session.done and session.done[a.key],'Track this clip first');local t=d.tool
      local use={};for _,n in ipairs(a.use or {}) do use[n]=true end
      for i=1,d.count do t:SetInput('Enabled'..(i+1),use[i] and 1 or 0) end
      if next(use) then t:SetInput('Operation',1);t:SetInput('Merge',0);t:SetInput('FilterMethod',2);t:SetInput('Position',1);t:SetInput('Rotation',0);t:SetInput('Scaling',0)
      else t:SetInput('Operation',0) end
      d.item:SetClipColor(a.passed and 'Green' or 'Orange');assert(r:GetProjectManager():SaveProject());r:OpenPage('edit');return {ok=true}
    elseif a.action=='finish' then
      assert(not active,'Wait for tracking to finish');local r,p,tl=context(a,true);r:GetProjectManager():SaveProject();r:OpenPage('edit');return {ok=true,timeline=tl:GetName()}
    end
    error('Unknown stabilization action')
  end
end
