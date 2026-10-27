-- Native Fusion Tracker batch. All edits are confined to a timeline duplicate.
return function(connect, array)
  local session, active
  local function context(a, duplicate)
    local r=assert(connect(),'Resolve is not connected');local p=assert(r:GetProjectManager():GetCurrentProject(),'Open a project')
    assert(session and p:GetUniqueId()==session.project,'Project changed; scan again')
    local tl=p:GetCurrentTimeline();assert(tl and tl:GetUniqueId()==(duplicate and session.copy or session.timeline),'Timeline changed; return to the scanned timeline')
    return r,p,tl
  end
  local DEFAULT_TOOLS={MediaIn=true,MediaOut=true,AudioDisplay=true}
  local function realComps(it)
    local n=0
    for i=1,it:GetFusionCompCount() do local c=it:GetFusionCompByIndex(i);local used=false
      for _,tool in pairs(c and c:GetToolList() or {}) do if not DEFAULT_TOOLS[tool:GetAttrs().TOOLS_RegID] then used=true end end
      if used then n=n+1 end
    end
    return n
  end
  -- Resolve never deletes a clip's last composition (DeleteFusionCompByName returns false):
  -- add an empty one first, then remove the others. Leaves no effect on the clip.
  local function clearComps(it)
    local old=it:GetFusionCompNameList() or {}
    if #old==0 then return end
    assert(it:AddFusionComp(),'Could not reset the Fusion effect')
    for _,name in ipairs(old) do it:DeleteFusionCompByName(name) end
    assert(realComps(it)==0,'Could not remove the Fusion effect; remove it by hand')
  end
  local function findTimeline(p,id)
    for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i);if x:GetUniqueId()==id then return x end end
  end
  local function seek(tl,frame)
    local fps=tonumber(tl:GetSetting('timelineFrameRate'));assert(fps and fps==math.floor(fps),'This preview currently requires a whole-number timeline frame rate')
    assert(tl:SetCurrentTimecode(string.format('%02d:%02d:%02d:%02d',math.floor(frame/(fps*3600)),math.floor(frame/(fps*60))%60,math.floor(frame/fps)%60,frame%fps)))
  end
  return function(a)
    if a.action=='list' then
      local r=assert(connect());local p=assert(r:GetProjectManager():GetCurrentProject(),'Open a project');local cur=p:GetCurrentTimeline();local out=array()
      for i=1,p:GetTimelineCount() do local tl=p:GetTimelineByIndex(i);local m={};local n=0
        for _,mk in pairs(tl:GetMarkers() or {}) do m[mk.color]=(m[mk.color] or 0)+1;n=n+1 end
        out[#out+1]={id=tl:GetUniqueId(),name=tl:GetName(),markers=m,count=n,current=cur and cur:GetUniqueId()==tl:GetUniqueId() or false}
      end
      return {ok=true,timelines=out}
    elseif a.action=='scan' then
      assert(not active,'Finish the current tracker first')
      local r=assert(connect());local p=assert(r:GetProjectManager():GetCurrentProject(),'Open a project')
      if a.timeline then local found
        for i=1,p:GetTimelineCount() do local x=p:GetTimelineByIndex(i);if x:GetUniqueId()==a.timeline then found=x end end
        assert(found,'Timeline not found; refresh the timeline list');assert(p:SetCurrentTimeline(found),'Could not open timeline '..found:GetName())
      end
      local tl=assert(p:GetCurrentTimeline(),'Open a timeline')
      local colors={};for _,m in pairs(tl:GetMarkers() or {}) do colors[m.color]=true end
      local list=array();for color in pairs(colors) do list[#list+1]=color end;table.sort(list)
      local clips=array();local refs={};local seen={}
      for frame,m in pairs(tl:GetMarkers() or {}) do if not a.color or a.color=='All' or m.color==a.color then
        local absolute=tl:GetStartFrame()+frame;local found=false
        for tr=tl:GetTrackCount('video'),1,-1 do
          for idx,it in ipairs(tl:GetItemListInTrack('video',tr)) do if tl:GetIsTrackEnabled('video',tr) and absolute>=it:GetStart() and absolute<it:GetEnd() and it:GetClipEnabled() then
            local key=tr..':'..idx
            local mk={frame=frame,color=m.color,name=m.name or '',note=m.note or '',duration=m.duration or 1}
            if not seen[key] then
              local row={key=key,track=tr,index=idx,name=it:GetName(),start=it:GetStart(),frames=it:GetEnd()-it:GetStart(),marker=m.name,note=m.note or '',color=m.color,fusion=realComps(it),clipColor=it:GetClipColor() or '',markers=array({mk})}
              clips[#clips+1]=row;refs[key]={item=it,start=row.start,frames=row.frames,track=tr,index=idx};seen[key]=row
            else local row=seen[key];row.markers[#row.markers+1]=mk end
            found=true;break
          end end
          if found then break end
        end
      end end
      table.sort(clips,function(x,y)return x.start<y.start end)
      session={project=p:GetUniqueId(),timeline=tl:GetUniqueId(),name=tl:GetName(),refs=refs,owned={},attempts={}};active=nil
      return {ok=true,colors=list,clips=clips,timeline=tl:GetName(),timelineId=tl:GetUniqueId()}
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
      -- Date and time in the name keep copies traceable for days ('Tracker' = forced tracker version).
      local copy=assert(tl:DuplicateTimeline(session.name..' - PostPilot '..(a.label=='Tracker' and 'Tracker' or 'Stabilized')..' '..os.date('%Y-%m-%d %H%M%S')),'Could not duplicate timeline');session.copy=copy:GetUniqueId();assert(p:SetCurrentTimeline(copy))
      return {ok=true,timeline=copy:GetName(),timelineId=copy:GetUniqueId()}
    elseif a.action=='frame' then
      assert(not active,'Wait for tracking to finish');local r,p,tl=context(a,true);local ref=assert(session.refs[a.key]);local it=assert(tl:GetItemListInTrack('video',ref.track)[ref.index])
      assert(it:GetStart()==ref.start and it:GetEnd()-it:GetStart()==ref.frames,'Clip was edited; scan again')
      local frame=assert(tonumber(a.frame));assert(frame>=0 and frame<ref.frames and frame==math.floor(frame));r:OpenPage('edit');seek(tl,ref.start+frame)
      assert(p:ExportCurrentFrameAsStill(assert(a.file)),'Could not read timeline output for verification');return {ok=true,frame=frame}
    elseif a.action=='track' then
      -- One Tracker tool, one classic point tracker per point (never IntelliTrack: it drifts).
      assert(not active,'Tracking already running');local r,p,tl=context(a,true);local ref=assert(session.refs[a.key]);local it=assert(tl:GetItemListInTrack('video',ref.track)[ref.index]);assert(it:GetStart()==ref.start and it:GetEnd()-it:GetStart()==ref.frames,'Clip was edited; scan again')
      assert(realComps(it)==0,'Clip already has Fusion effects; retained for manual review')
      local pts=assert(a.points);assert(#pts>=1,'No fixed points to track')
      seek(tl,ref.start);local c=it:GetFusionCompCount()>0 and it:GetFusionCompByIndex(1) or assert(it:AddFusionComp());r:OpenPage('fusion');local t=assert(c:AddTool('Tracker',1,0));local mi,mo
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
      session.done=session.done or {};session.done[active.key]={comp=c,tool=t,item=active.item,count=active.count};active=nil;r:OpenPage('edit')
      return {ok=true,running=false,paths=paths,width=tonumber(tl:GetSetting('timelineResolutionWidth')),height=tonumber(tl:GetSetting('timelineResolutionHeight')),fps=tonumber(tl:GetSetting('timelineFrameRate'))}
    elseif a.action=='apply' then
      -- Keep only the agreeing points; Match Move averages the enabled trackers.
      assert(not active);local r,p,tl=context(a,true);local d=assert(session.done and session.done[a.key],'Track this clip first');local t=d.tool
      local use={};for _,n in ipairs(a.use or {}) do use[n]=true end
      for i=1,d.count do t:SetInput('Enabled'..(i+1),use[i] and 1 or 0) end
      local smooth=a.cx and a.cy -- per-frame correction (Smooth, or Lock when trackers slip)
      if next(use) and not smooth then t:SetInput('Operation',1);t:SetInput('Merge',0);t:SetInput('FilterMethod',2);t:SetInput('Position',1);t:SetInput('Rotation',0);t:SetInput('Scaling',0)
      else t:SetInput('Operation',0) end
      -- Transform after the tracker: slight zoom hides black edges; in Smooth mode it
      -- also carries the per-frame shake correction (camera moves are kept).
      local zoom=tonumber(a.zoom) or 1
      if next(use) and (zoom>1 or smooth) then local c=d.comp;local mo
        for _,tool in pairs(c:GetToolList()) do if tool:GetAttrs().TOOLS_RegID=='MediaOut' then mo=tool end end
        local xf=assert(c:AddTool('Transform',2,0));xf:SetAttrs({TOOLS_Name=smooth and 'PostPilotSmooth' or 'PostPilotEdgeZoom'});xf:ConnectInput('Input',t);xf:SetInput('Size',zoom);assert(mo):ConnectInput('Input',xf)
        if smooth then
          xf:AddModifier('Center','XYPath')
          for n=1,#a.cx do xf:SetInput('Center',{.5+a.cx[n],.5+a.cy[n]},n-1) end
        end
      end
      d.item:SetClipColor(a.passed and 'Green' or 'Orange');assert(r:GetProjectManager():SaveProject());r:OpenPage('edit');return {ok=true}
    elseif a.action=='resolvestab' then
      -- Fallback for shots without a rigid reference: Resolve's own stabilizer (whole-
      -- picture analysis, default settings). Any tracking comp made for the clip goes first.
      assert(not active,'Wait for tracking to finish');local r,p,tl=context(a,true);local ref=assert(session.refs[a.key]);local it=assert(tl:GetItemListInTrack('video',ref.track)[ref.index])
      assert(it:GetStart()==ref.start and it:GetEnd()-it:GetStart()==ref.frames,'Clip was edited; scan again')
      clearComps(it)
      if session.done then session.done[a.key]=nil end
      r:OpenPage('edit');seek(tl,ref.start);r:OpenPage('color');local ok=it:Stabilize();r:OpenPage('edit')
      assert(ok,"Resolve's stabilizer could not analyse this clip")
      it:SetClipColor('Yellow');r:GetProjectManager():SaveProject();return {ok=true}
    elseif a.action=='deletecopies' then
      -- Remove PostPilot's own stabilized copies (only names it created), after approval.
      local r=assert(connect());local p=assert(r:GetProjectManager():GetCurrentProject(),'Open a project')
      local doomed,cur={},p:GetCurrentTimeline()
      for _,id in ipairs(a.ids or {}) do local tl=findTimeline(p,id)
        if tl then local n=tl:GetName();assert(n:match(' %- PostPilot Stabilized [%d%- ]*%d%d%d%d%d%d$') or n:match(' %- PostPilot Tracker [%d%- ]*%d%d%d%d%d%d$'),'Not a PostPilot copy: '..n);doomed[#doomed+1]=tl end end
      if #doomed==0 then return {ok=true,deleted=0} end
      for _,tl in ipairs(doomed) do if cur and cur:GetUniqueId()==tl:GetUniqueId() then local back=findTimeline(p,a.back);if back then p:SetCurrentTimeline(back) end end end
      assert(p:GetMediaPool():DeleteTimelines(doomed),'Resolve could not delete the copy timelines')
      r:GetProjectManager():SaveProject();return {ok=true,deleted=#doomed}
    elseif a.action=='goto' then
      -- Jump Resolve to a clip: the stabilized copy or your original timeline.
      local r=assert(connect());local p=assert(r:GetProjectManager():GetCurrentProject(),'Open a project')
      local tl=assert(findTimeline(p,a.timeline),'Timeline not found (deleted or renamed?)');assert(p:SetCurrentTimeline(tl))
      r:OpenPage('edit');seek(tl,tonumber(a.start)+math.min(2,tonumber(a.frames or 1)-1));return {ok=true}
    elseif a.action=='approve' then
      -- Copy the stabilization from the copy onto the same clip in your timeline.
      local r=assert(connect());local p=assert(r:GetProjectManager():GetCurrentProject(),'Open a project')
      local ctl=assert(findTimeline(p,a.copy),'Stabilized copy not found');local otl=assert(findTimeline(p,a.timeline),'Your timeline was not found')
      local src=ctl:GetItemListInTrack('video',a.track)[a.index];local dst=otl:GetItemListInTrack('video',a.track)[a.index]
      assert(src and src:GetStart()==a.start and src:GetDuration()==a.frames,'The clip in the copy was moved; apply it by hand')
      assert(dst and dst:GetStart()==a.start and dst:GetDuration()==a.frames,'The clip in your timeline was edited since; not replaced')
      assert(realComps(dst)==0,'Your clip has its own Fusion effects now; not replaced')
      if a.method=='resolve' then
        assert(p:SetCurrentTimeline(otl));seek(otl,a.start);r:OpenPage('color');local ok=dst:Stabilize();r:OpenPage('edit')
        assert(ok,"Resolve's stabilizer could not analyse this clip")
        if a.color and a.color~='' then dst:SetClipColor(a.color) else dst:ClearClipColor() end
        if a.removeMarkers then for _,mk in ipairs(a.markers or {}) do otl:DeleteMarkerAtFrame(mk.frame) end end
        src:SetClipColor('Teal');assert(r:GetProjectManager():SaveProject());return {ok=true}
      end
      local idx;for i=1,src:GetFusionCompCount() do local c=src:GetFusionCompByIndex(i);for _,tool in pairs(c:GetToolList()) do if not DEFAULT_TOOLS[tool:GetAttrs().TOOLS_RegID] then idx=idx or i end end end
      assert(idx,'This clip has no stabilization to apply')
      assert(src:ExportFusionComp(a.file,idx),'Could not export the stabilization')
      -- Only empty default comps can be on the clip here; replace them with the stabilization
      -- (import first: then they are no longer the clip's last composition and can go).
      local old=dst:GetFusionCompNameList() or {}
      assert(dst:ImportFusionComp(a.file),'Could not apply the stabilization')
      for _,name in ipairs(old) do dst:DeleteFusionCompByName(name) end
      if a.color and a.color~='' then dst:SetClipColor(a.color) else dst:ClearClipColor() end
      if a.removeMarkers then for _,mk in ipairs(a.markers or {}) do otl:DeleteMarkerAtFrame(mk.frame) end end
      src:SetClipColor('Teal');assert(r:GetProjectManager():SaveProject());return {ok=true}
    elseif a.action=='undo' then
      -- Take the applied stabilization off your clip again (and put markers back).
      local r=assert(connect());local p=assert(r:GetProjectManager():GetCurrentProject(),'Open a project')
      local otl=assert(findTimeline(p,a.timeline),'Your timeline was not found');local dst=otl:GetItemListInTrack('video',a.track)[a.index]
      assert(dst and dst:GetStart()==a.start and dst:GetDuration()==a.frames,'The clip in your timeline was edited since; remove the Fusion effect by hand')
      clearComps(dst)
      if a.restoreMarkers then local have=otl:GetMarkers() or {}
        for _,mk in ipairs(a.markers or {}) do if not have[mk.frame] then otl:AddMarker(mk.frame,mk.color,mk.name,mk.note,mk.duration) end end end
      assert(r:GetProjectManager():SaveProject());return {ok=true}
    elseif a.action=='finish' then
      assert(not active,'Wait for tracking to finish');local r,p,tl=context(a,true);r:GetProjectManager():SaveProject();r:OpenPage('edit');return {ok=true,timeline=tl:GetName()}
    end
    error('Unknown stabilization action')
  end
end
