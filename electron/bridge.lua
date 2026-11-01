-- AV PostPilot <-> DaVinci Resolve bridge.
-- Runs inside Resolve's own fuscript.exe (Lua 5.1), so no Python is needed.
-- Reads one command per line on stdin, answers one JSON object per line on stdout.
--   status
--   export<TAB><full path of .drp to write>
--   save        (save the current project)
--   quit

io.stdout:setvbuf("no")

---------------------------------------------------------------- JSON encode
local function esc(s)
  s = s:gsub('[%c"\\]', function(c)
    local map = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
    return map[c] or string.format('\\u%04x', c:byte())
  end)
  return '"' .. s .. '"'
end

local encode
local ARRAY = {}                      -- metatable marking a table as a JSON array
local function array(t) return setmetatable(t or {}, ARRAY) end

local function is_array(t)
  if getmetatable(t) == ARRAY then return true end
  local n = 0
  for k in pairs(t) do
    if type(k) ~= 'number' then return false end
    n = n + 1
  end
  return n > 0 and n == #t
end

encode = function(v)
  local t = type(v)
  if v == nil then return 'null'
  elseif t == 'boolean' then return tostring(v)
  elseif t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then return 'null' end
    return tostring(v)
  elseif t == 'string' then return esc(v)
  elseif t == 'table' then
    local out = {}
    if is_array(v) then
      for i = 1, #v do out[#out + 1] = encode(v[i]) end
      return '[' .. table.concat(out, ',') .. ']'
    end
    for k, val in pairs(v) do
      if type(val) ~= 'function' and type(val) ~= 'userdata' then
        out[#out + 1] = esc(tostring(k)) .. ':' .. encode(val)
      end
    end
    return '{' .. table.concat(out, ',') .. '}'
  end
  return 'null'
end

local function reply(t) io.write(encode(t), '\n'); io.flush() end

---------------------------------------------------------------- Resolve
local resolve
local encoderSession

local function connect()
  if resolve then
    local ok, pm = pcall(function() return resolve:GetProjectManager() end)
    if ok and pm then return resolve end
    resolve = nil
  end
  local ok, r = pcall(function() return bmd.scriptapp('Resolve', 'localhost') end)
  if ok and r then resolve = r end
  return resolve
end

-- Clip under the playhead, for the always-on-top Clip Info window.
local function clipinfo()
  local r = connect()
  if not r then return { ok = true, connected = false } end
  local p = r:GetProjectManager():GetCurrentProject()
  local tl = p and p:GetCurrentTimeline()
  if not tl then return { ok = true, connected = true } end
  local res = { ok = true, connected = true, timeline = tl:GetName(), timecode = tl:GetCurrentTimecode(),
    fps = tonumber(tl:GetSetting('timelineFrameRate')), tlStart = tl:GetStartFrame(), page = r:GetCurrentPage() }
  local it = tl:GetCurrentVideoItem()
  if it then
    local c = { name = it:GetName(), start = it:GetStart(), duration = it:GetDuration(), sourceIn = it:GetLeftOffset(),
      color = it:GetClipColor(), fusion = it:GetFusionCompCount(), enabled = it:GetClipEnabled() }
    pcall(function() local t = it:GetTrackTypeAndIndex(); c.track = t[2] end)
    local m = it:GetMediaPoolItem()
    if m then
      local pr = m:GetClipProperty() or {}
      c.file = pr['File Path']; c.resolution = pr['Resolution']; c.clipFps = pr['FPS']; c.codec = pr['Video Codec']
      c.sourceDuration = pr['Duration']; c.audioCh = pr['Audio Ch']; c.created = pr['Date Created']; c.size = pr['File Size'] or pr['Size']
    end
    local marks = array()
    for f, mk in pairs(it:GetMarkers() or {}) do marks[#marks + 1] = { frame = f, color = mk.color, name = mk.name, note = mk.note } end
    c.markers = marks
    res.clip = c
  end
  return res
end

local function status()
  local r = connect()
  if not r then return { ok = true, connected = false } end
  local res = { ok = true, connected = true }
  pcall(function() res.product = r:GetProductName() end)
  pcall(function() res.version = r:GetVersionString() end)
  local pm = r:GetProjectManager()
  local p = pm and pm:GetCurrentProject()
  if p then
    local proj = { name = p:GetName(), id = p:GetUniqueId() }
    pcall(function()
      local db = pm:GetCurrentDatabase()
      if db then proj.dbType = db.DbType; proj.dbName = db.DbName end
    end)
    pcall(function() proj.folder = pm:GetCurrentFolder() end)
    res.project = proj
    res.encoderProject = encoderSession and p:GetUniqueId() == encoderSession.id or false
    pcall(function() res.rendering = p:IsRenderingInProgress() end)
    local jobs = array()
    pcall(function()
      for _, j in ipairs(p:GetRenderJobList() or {}) do
        local s = p:GetRenderJobStatus(j.JobId) or {}
        jobs[#jobs + 1] = {
          id = j.JobId, name = j.RenderJobName, timeline = j.TimelineName,
          dir = j.TargetDir, file = j.OutputFilename,
          width = j.FormatWidth, height = j.FormatHeight, markIn = j.MarkIn, markOut = j.MarkOut,
          status = s.JobStatus, percent = s.CompletionPercentage,
          etaMs = s.EstimatedTimeRemainingInMs, tookMs = s.TimeTakenToRenderInMs, error = s.Error,
        }
      end
    end)
    res.jobs = jobs
  end
  return res
end

local function export(path)
  local r = connect()
  if not r then return { ok = false, error = 'Resolve is not running or external scripting is off' } end
  local pm = r:GetProjectManager()
  local p = pm:GetCurrentProject()
  if not p then return { ok = false, error = 'No project open' } end
  local name = p:GetName()
  local done = pm:ExportProject(name, path, true)
  return { ok = done == true, project = name, path = path,
           error = (done ~= true) and 'Resolve refused the export' or nil }
end

local function save()
  local r = connect()
  if not r then return { ok = false, error = 'Resolve is not running or external scripting is off' } end
  local pm = r:GetProjectManager()
  if not pm:GetCurrentProject() then return { ok = false, error = 'No project open' } end
  return { ok = pm:SaveProject() == true }
end

---------------------------------------------------------------- project tools
-- Arguments arrive as a Lua table literal built by the app (no JSON parser in Lua 5.1).
local function parse(arg)
  local f, err = loadstring('return ' .. arg)
  if not f then error('bad arguments: ' .. tostring(err)) end
  setfenv(f, {})
  return f()
end

local function project()
  local r = connect()
  if not r then error('Resolve is not running or external scripting is off') end
  local pm = r:GetProjectManager()
  return pm, pm:GetCurrentProject()
end

local function subfolder(mp, parent, name)
  for _, f in ipairs(parent:GetSubFolderList() or {}) do
    if f:GetName() == name then return f end
  end
  return mp:AddSubFolder(parent, name)
end

local function folderPath(mp, parts)
  local f = mp:GetRootFolder()
  for _, name in ipairs(parts) do
    f = subfolder(mp, f, name)
    if not f then error('could not create bin ' .. name) end
  end
  return f
end

local function timelinesByName(p)
  local map = {}
  for i = 1, p:GetTimelineCount() do
    local t = p:GetTimelineByIndex(i)
    if t then map[t:GetName()] = t end
  end
  return map
end

local function setup(a)
  local pm = project()
  local p = pm:CreateProject(a.project)
  if not p then return { ok = false, error = 'Could not create project "' .. a.project .. '" (does it already exist in this library?)' } end
  local mp = p:GetMediaPool()
  for _, b in ipairs(a.bins) do folderPath(mp, { b }) end

  -- Import the footage, mirroring the folder tree as nested bins.
  local byPath, imported = {}, 0
  for _, d in ipairs(a.dirs) do
    local bin = folderPath(mp, d.bin)
    if #d.files > 0 then
      mp:SetCurrentFolder(bin)
      for _, item in ipairs(mp:ImportMedia(d.files) or {}) do
        imported = imported + 1
        byPath[string.lower(item:GetClipProperty('File Path') or '')] = item
      end
    end
  end

  -- Project format from the first clip (must be set before any timeline exists).
  local format = {}
  local first = a.timelines[1] and byPath[string.lower(a.timelines[1].clips[1] or '')]
  if first then
    local w, h = string.match(first:GetClipProperty('Resolution') or '', '(%d+)%s*x%s*(%d+)')
    local fps = first:GetClipProperty('FPS')
    if w then p:SetSetting('timelineResolutionWidth', w); p:SetSetting('timelineResolutionHeight', h) end
    if fps and fps ~= '' then p:SetSetting('timelineFrameRate', tostring(fps)) end
    format = { resolution = (w and (w .. 'x' .. h)) or nil, fps = fps }
  end

  local made, problems = array(), array()
  mp:SetCurrentFolder(folderPath(mp, { 'Sequence' }))
  for _, t in ipairs(a.timelines) do
    local items, missing = {}, 0
    for _, f in ipairs(t.clips) do
      local item = byPath[string.lower(f)]
      if item then items[#items + 1] = item else missing = missing + 1 end
    end
    if #items == 0 then
      problems[#problems + 1] = t.master .. ': no clips imported'
    else
      local tl = mp:CreateTimelineFromClips(t.master, items)
      if tl then
        made[#made + 1] = t.master
        local dup = tl:DuplicateTimeline(t.edit)
        if dup then made[#made + 1] = t.edit else problems[#problems + 1] = t.edit .. ': could not duplicate' end
      else
        problems[#problems + 1] = t.master .. ': could not create timeline'
      end
      if missing > 0 then problems[#problems + 1] = t.master .. ': ' .. missing .. ' clip(s) missing' end
    end
  end
  pm:SaveProject()
  return { ok = true, project = a.project, imported = imported, timelines = made, problems = problems, format = format }
end

local function textPlus(item)
  if not item or item:GetFusionCompCount() < 1 then return nil end
  local comp = item:GetFusionCompByIndex(1)
  local tools = comp and comp:GetToolList(false, 'TextPlus')
  return tools and tools[1]
end

local function titleItem(tl)
  local best
  for track = 1, tl:GetTrackCount('video') do
    for _, it in ipairs(tl:GetItemListInTrack('video', track) or {}) do
      if textPlus(it) and (not best or it:GetStart() < best:GetStart()) then best = it end
    end
  end
  return best
end

local function series(a)
  local pm, p = project()
  if not p then return { ok = false, error = 'No project open' } end
  local mp = p:GetMediaPool()
  local existing = timelinesByName(p)
  mp:SetCurrentFolder(folderPath(mp, { a.bin or 'Episode' }))
  local made, skipped, problems = array(), array(), array()
  for _, e in ipairs(a.episodes) do
    if existing[e.name] then
      skipped[#skipped + 1] = e.name
    else
      local tl = mp:CreateEmptyTimeline(e.name)
      if not tl then
        problems[#problems + 1] = e.name .. ': could not create timeline'
      else
        p:SetCurrentTimeline(tl)
        local titleItem = tl:InsertFusionTitleIntoTimeline('Text+')
        local tp = textPlus(titleItem)
        -- Episode standard: 5 s title, then 5 s of black (Solid Color is black by default).
        -- Both lengths come from Resolve's "Standard generator duration" preference.
        if titleItem then
          local fps = math.floor((tonumber(tl:GetSetting('timelineFrameRate')) or 25) + 0.5)
          local f = titleItem:GetEnd()
          tl:SetCurrentTimecode(string.format('%02d:%02d:%02d:%02d', math.floor(f / (fps * 3600)), math.floor(f / (fps * 60)) % 60, math.floor(f / fps) % 60, f % fps))
          local black = tl:InsertGeneratorIntoTimeline('Solid Color')
          if not black then problems[#problems + 1] = e.name .. ': 5 s black could not be added'
          elseif black:GetStart() ~= titleItem:GetEnd() then problems[#problems + 1] = e.name .. ': black was not placed right after the title' end
          if titleItem:GetDuration() ~= 5 * fps or (black and black:GetDuration() ~= 5 * fps) then
            problems[#problems + 1] = e.name .. ': title/black are not 5 s; set Preferences > User > Editing > Standard generator duration to 5 seconds'
          end
        end
        if tp then
          tp:SetInput('StyledText', e.line1 .. '\n' .. e.subtitle)
          tp:SetInput('Font', a.font or 'Calibri')
          tp:SetInput('Style', a.style or 'Bold')
          if a.size then tp:SetInput('Size', a.size) end
          if a.centerY then tp:SetInput('Center', { 0.5, a.centerY }) end
          if a.background and a.background ~= '' then
            -- Picture (e.g. colour bars) behind the text, inside the same title:
            -- Resolve's scripting can only insert titles/generators on V1.
            local comp = tp.Composition
            local out = comp:GetToolList(false, 'MediaOut')[1]
            comp:Lock()
            local loader = comp:AddTool('Loader', -32768, -32768)
            loader.Clip = a.background
            local merge = comp:AddTool('Merge', -32768, -32768)
            merge.Background = loader.Output
            merge.Foreground = tp.Output
            if out then out.Input = merge.Output end
            comp:Unlock()
          end
          made[#made + 1] = e.name
        else
          problems[#problems + 1] = e.name .. ': title could not be added'
        end
      end
    end
  end
  pm:SaveProject()
  return { ok = true, made = made, skipped = skipped, problems = problems }
end

-- A still of Resolve's SMPTE colour bars at the project's resolution, made once
-- per resolution and reused (a.dir is PostPilot's data folder).
local function barsstill(a)
  local r = connect()
  local pm, p = project()
  if not p then return { ok = false, error = 'No project open' } end
  local w = p:GetSetting('timelineResolutionWidth') or '1920'
  local h = p:GetSetting('timelineResolutionHeight') or '1080'
  local path = a.dir .. '\\bars_smpte_' .. w .. 'x' .. h .. '.png'
  local f = io.open(path, 'rb')
  if f then f:close(); return { ok = true, path = path } end
  local mp = p:GetMediaPool()
  local previous = p:GetCurrentTimeline()
  local tl = mp:CreateEmptyTimeline('PostPilot bars ' .. os.time())
  if not tl then return { ok = false, error = 'could not create a temporary timeline' } end
  p:SetCurrentTimeline(tl)
  local gen = tl:InsertGeneratorIntoTimeline('SMPTE Color Bar')
  local ok = false
  if gen then
    r:OpenPage('color'); bmd.wait(1.5)
    tl:SetCurrentTimecode(tl:GetStartTimecode()); bmd.wait(1)
    ok = p:ExportCurrentFrameAsStill(path)
    r:OpenPage('edit')
  end
  mp:DeleteTimelines({ tl })
  if previous then p:SetCurrentTimeline(previous) end
  return { ok = ok == true, path = path, error = (ok ~= true) and 'could not make the colour bars picture' or nil }
end

local function timelines()
  local _, p = project()
  if not p then return { ok = false, error = 'No project open' } end
  local names = array()
  for i = 1, p:GetTimelineCount() do
    local t = p:GetTimelineByIndex(i)
    if t then names[#names + 1] = t:GetName() end
  end
  return { ok = true, project = p:GetName(), names = names }
end

local function rename(a)
  local pm, p = project()
  if not p then return { ok = false, error = 'No project open' } end
  local all = timelinesByName(p)
  for _, it in ipairs(a.items) do
    if not all[it.old] then return { ok = false, error = 'Timeline not found: ' .. it.old } end
    if all[it.name] and not a.oldSet[it.name] then
      return { ok = false, error = 'A timeline called "' .. it.name .. '" already exists' }
    end
  end
  -- Two passes so renumbering inside the same series never collides.
  local tmp = {}
  for i, it in ipairs(a.items) do
    tmp[i] = all[it.old]
    tmp[i]:SetName('__pp_rename_' .. i .. '_' .. os.time())
  end
  local done, problems = 0, array()
  for i, it in ipairs(a.items) do
    local tl = tmp[i]
    if not tl:SetName(it.name) then problems[#problems + 1] = it.old .. ': could not rename' end
    local tp = textPlus(titleItem(tl))
    if tp then
      local current = tp:GetInput('StyledText') or ''
      local rest = string.match(current, '^[^\r\n]*[\r\n]+(.*)$') or ''
      tp:SetInput('StyledText', it.line1 .. '\n' .. (it.subtitle or rest))
    else
      problems[#problems + 1] = it.name .. ': no Text+ title found, name changed only'
    end
    done = done + 1
  end
  pm:SaveProject()
  return { ok = true, renamed = done, problems = problems }
end

local function countItems(tl)
  local n = 0
  for track = 1, tl:GetTrackCount('video') do n = n + #(tl:GetItemListInTrack('video', track) or {}) end
  return n
end

-- Scene cut detection on one timeline (blocks until Resolve has finished).
local function detect(a)
  local pm, p = project()
  if not p then return { ok = false, error = 'No project open' } end
  local tl = timelinesByName(p)[a.name]
  if not tl then return { ok = false, error = 'Timeline not found: ' .. a.name } end
  p:SetCurrentTimeline(tl)
  local before = countItems(tl)
  local t0 = os.time()
  local done = tl:DetectSceneCuts()
  local after = countItems(tl)
  pm:SaveProject()
  return { ok = done == true, name = a.name, before = before, after = after, seconds = os.time() - t0,
           error = (done ~= true) and 'Resolve could not detect scene cuts on this timeline' or nil }
end

local function presets()
  local _, p = project()
  if not p then return { ok = false, error = 'No project open' } end
  -- Resolve returns this list with gaps (e.g. no entry 21). ipairs stops at
  -- the first gap, which hid every preset after it, including custom ones.
  local raw, keys = p:GetRenderPresetList() or {}, {}
  for k, v in pairs(raw) do
    if type(k) == 'number' and type(v) == 'string' and v ~= '' then keys[#keys + 1] = k end
  end
  table.sort(keys)
  local list = array()
  for _, k in ipairs(keys) do list[#list + 1] = raw[k] end
  return { ok = true, presets = list }
end

-- Resolve ignores LoadRenderPreset for the preset that is already selected,
-- even when the settings were changed since. Switch to another preset first.
local function applyPreset(p, name)
  for _, other in ipairs(p:GetRenderPresetList() or {}) do
    if other ~= name then p:LoadRenderPreset(other); break end
  end
  return p:LoadRenderPreset(name)
end

-- HD review pass, encoder style: tonight's exports go on ONE temporary timeline
-- in a temporary bin and render as "Individual clips" (one file per episode).
-- Presets that don't allow Individual clips (Resolve's web presets) fall back
-- to one temporary timeline per episode. Everything temporary is removed by
-- hdcleanup once the renders are done; the files on disk stay.
local function hdbatch(a)
  local pm, p = project()
  if not p then return { ok = false, error = 'No project open' } end
  local mp = p:GetMediaPool()
  local previous = p:GetCurrentTimeline()
  local folder = mp:AddSubFolder(mp:GetRootFolder(), a.folder)
  if not folder then return { ok = false, error = 'could not create a temporary bin' } end
  mp:SetCurrentFolder(folder)
  local byPath, problems = {}, array()
  for _, item in ipairs(mp:ImportMedia(a.files) or {}) do
    byPath[string.lower(item:GetClipProperty('File Path') or '')] = item
  end
  local clips = {}
  for _, f in ipairs(a.files) do
    local c = byPath[string.lower(f)]
    if c then clips[#clips + 1] = c else problems[#problems + 1] = 'could not import ' .. f end
  end
  if #clips == 0 then return { ok = false, error = 'none of the rendered files could be imported', problems = problems } end

  local ids = array()
  local tl = mp:CreateTimelineFromClips(a.folder, clips)
  if not tl then return { ok = false, error = 'could not create the temporary timeline', problems = problems } end
  p:SetCurrentTimeline(tl)
  if not applyPreset(p, a.preset) then return { ok = false, error = 'could not load preset "' .. a.preset .. '"', problems = problems } end
  p:SetCurrentRenderMode(0)                           -- 0 = Individual clips
  local mode = 'individual'
  if p:GetCurrentRenderMode() == 0 then
    p:SetRenderSettings({ SelectAllFrames = true, TargetDir = a.dir })
    ids[#ids + 1] = p:AddRenderJob()
  else
    -- This preset only allows single-clip renders: one temporary timeline per episode.
    mode = 'per-episode'
    mp:DeleteTimelines({ tl })
    for i, c in ipairs(clips) do
      local one = mp:CreateTimelineFromClips(a.folder .. ' ' .. i, { c })
      if one and p:SetCurrentTimeline(one) and applyPreset(p, a.preset) then
        p:SetRenderSettings({ SelectAllFrames = true, TargetDir = a.dir, CustomName = a.names[i] })
        ids[#ids + 1] = p:AddRenderJob()
      else
        problems[#problems + 1] = 'could not set up ' .. a.names[i]
      end
    end
  end
  if previous then p:SetCurrentTimeline(previous) end
  local started = #ids > 0 and p:StartRendering(ids, false)
  return { ok = #ids > 0 and started == true, ids = ids, mode = mode, problems = problems,
           error = (#ids == 0) and 'no HD render job could be added' or ((started ~= true) and 'Resolve did not start rendering' or nil) }
end

local function hdcleanup(a)
  local _, p = project()
  if not p then return { ok = false, error = 'No project open' } end
  local mp = p:GetMediaPool()
  local folder
  for _, f in ipairs(mp:GetRootFolder():GetSubFolderList() or {}) do
    if f:GetName() == a.folder then folder = f end
  end
  if not folder then return { ok = true, removed = 0 } end
  local tls = {}
  for i = 1, p:GetTimelineCount() do
    local t = p:GetTimelineByIndex(i)
    local n = t and t:GetName() or ''
    if n == a.folder or string.sub(n, 1, #a.folder + 1) == a.folder .. ' ' then tls[#tls + 1] = t end
  end
  if #tls > 0 then mp:DeleteTimelines(tls) end
  local clips = folder:GetClipList() or {}
  if #clips > 0 then mp:DeleteClips(clips) end
  local ok = mp:DeleteFolders({ folder })
  return { ok = ok == true, removed = #tls }
end

-- Encoder: one file -> one temporary timeline that matches the file's own frame
-- rate and size (so nothing is retimed or reframed), rendered with a preset as a
-- single clip named exactly as asked. Temporary items live in bin a.folder and
-- are removed afterwards with hdcleanup.
local function encbegin(a)
  local r = connect()
  if not r then return { ok = false, error = 'Resolve is not connected' } end
  if encoderSession then return { ok = false, error = 'An encoder workspace already exists; finish its cleanup first' } end
  local pm = r:GetProjectManager()
  local original = pm:GetCurrentProject()
  if (original and original:GetUniqueId() or '') ~= (a.originalId or '') then
    return { ok = false, error = 'The open project changed. Start Encoder again to confirm the current project.' }
  end
  if original then
    if original:IsRenderingInProgress() then return { ok = false, error = 'Wait for the current render to finish' } end
    -- Saving a never-saved "Untitled Project" makes Resolve ask for a name and wait.
    -- An empty one is Resolve's placeholder (it can't be closed); the temporary project
    -- simply replaces it. One with work in it must be saved by the user.
    if string.find(original:GetName() or '', '^Untitled Project') then
      local root = original:GetMediaPool():GetRootFolder()
      if (original:GetTimelineCount() or 0) > 0 or #(root:GetClipList() or {}) > 0 or #(root:GetSubFolderList() or {}) > 0 then
        return { ok = false, error = '"' .. original:GetName() .. '" has never been saved. Save it with a name in Resolve (File > Save Project), then start Encoder again.' }
      end
    else
      if pm:SaveProject() ~= true then return { ok = false, error = 'Resolve could not save your project. Encoding was not started.' } end
      if pm:CloseProject(original) ~= true then return { ok = false, error = 'Resolve could not close your saved project' } end
    end
  end
  local created, p = pcall(function() return pm:CreateProject(a.name) end)
  if not created or not p then
    return { ok = false, error = 'Could not create the temporary encoder project' }
  end
  encoderSession = { token = a.token, id = p:GetUniqueId(), name = p:GetName(), folder = pm:GetCurrentFolder(), database = pm:GetCurrentDatabase() }
  return { ok = true }
end

local function encowned(a)
  local _, p = project()
  if not encoderSession or encoderSession.token ~= a.token or not p or p:GetUniqueId() ~= encoderSession.id then
    return nil, 'Encoder workspace changed or connection was restarted. Queue stopped to protect your project.'
  end
  return p
end

local function encfinish(a)
  local p, err = encowned(a)
  if not p then return { ok = false, error = err } end
  if p:IsRenderingInProgress() then return { ok = false, error = 'Temporary project is still rendering; cleanup postponed' } end
  local pm = connect():GetProjectManager()
  local s = encoderSession
  local db = pm:GetCurrentDatabase() or {}
  local old = s.database or {}
  if pm:GetCurrentFolder() ~= s.folder or db.DbName ~= old.DbName or db.DbType ~= old.DbType or db.IpAddress ~= old.IpAddress or p:GetName() ~= s.name then
    return { ok = false, error = 'Project location or name changed; temporary project retained for safety' }
  end
  if pm:CloseProject(p) ~= true then return { ok = false, error = 'Could not close temporary project' } end
  local removed = pm:DeleteProject(s.name) == true
  encoderSession = nil
  return { ok = removed, error = not removed and 'Temporary project could not be deleted' or nil }
end

local function encstart(a)
  local owned, err = encowned(a)
  if not owned then return { ok = false, fatal = true, error = err } end
  local _, p = project()
  if not p then return { ok = false, error = 'No project open in Resolve' } end
  local mp = p:GetMediaPool()
  local root = mp:GetRootFolder()
  local folder
  for _, f in ipairs(root:GetSubFolderList() or {}) do if f:GetName() == a.folder then folder = f end end
  folder = folder or mp:AddSubFolder(root, a.folder)
  if not folder then return { ok = false, error = 'could not create a temporary bin' } end
  mp:SetCurrentFolder(folder)
  local got = mp:ImportMedia({ a.file })
  local clip = got and got[1]
  if not clip then return { ok = false, error = 'Resolve could not import this file' } end
  local fps = clip:GetClipProperty('FPS')
  local w, h = string.match(clip:GetClipProperty('Resolution') or '', '(%d+)%s*x%s*(%d+)')
  local tl = mp:CreateEmptyTimeline(a.timeline)
  if not tl then return { ok = false, error = 'could not create a temporary timeline' } end
  tl:SetSetting('useCustomSettings', '1')
  if fps and tostring(fps) ~= '' then tl:SetSetting('timelineFrameRate', tostring(fps)) end
  if w then tl:SetSetting('timelineResolutionWidth', w); tl:SetSetting('timelineResolutionHeight', h) end
  local previous = p:GetCurrentTimeline()
  p:SetCurrentTimeline(tl)
  local placed = mp:AppendToTimeline({ clip })
  if not placed or #placed == 0 then return { ok = false, error = 'could not place the file on the timeline' } end
  if not applyPreset(p, a.preset) then return { ok = false, error = 'could not load preset "' .. a.preset .. '"' } end
  p:SetCurrentRenderMode(1)                             -- single clip
  local render = { SelectAllFrames = true, TargetDir = a.dir, CustomName = a.name }
  -- A range picked in PostPilot: start times of the first and last frame, both included (like Premiere's in/out).
  if a.inSec and a.outSec then
    local rate = tonumber(tl:GetSetting('timelineFrameRate')) or tonumber(fps) or 25
    local start = tl:GetStartFrame()
    local last = tl:GetEndFrame() - 1
    local mi = math.min(last, start + math.floor(a.inSec * rate + 0.5))
    local mo = math.min(last, start + math.floor(a.outSec * rate + 0.5))
    if mo < mi then return { ok = false, error = 'the selected range is empty' } end
    render = { SelectAllFrames = false, MarkIn = mi, MarkOut = mo, TargetDir = a.dir, CustomName = a.name }
  end
  p:SetRenderSettings(render)
  local id = p:AddRenderJob()
  if previous then p:SetCurrentTimeline(previous) end
  if not id then return { ok = false, error = 'Resolve could not add the render job' } end
  if not p:StartRendering({ id }, false) then return { ok = false, error = 'Resolve did not start rendering' } end
  return { ok = true, id = id, fps = fps, resolution = w and (w .. 'x' .. h) or nil }
end

-- After a Quiet Lift render (toresolve.js): the lifted WAV into a bin, onto a timeline, then the Fairlight page.
-- a = { file, bin, timeline = 'current' | 'new', name, isolation = Voice Isolation amount 0-100 or nil }
local function chainimport(a)
  local r = connect()
  local _, p = project()
  if not p then return { ok = false, error = 'No project open in Resolve' } end
  -- On the Project Manager there is no page, the project is a placeholder and bins can't be made
  local page = r:GetCurrentPage()
  if not page or page == '' then return { ok = false, error = 'Resolve is on the Project Manager, open a project and Render again' } end
  local mp = p:GetMediaPool()
  local folder = folderPath(mp, { a.bin })
  mp:SetCurrentFolder(folder)
  local got = mp:ImportMedia({ a.file })
  local clip = got and got[1]
  if not clip then return { ok = false, error = 'Resolve could not import ' .. a.file } end
  local tl = a.timeline == 'current' and p:GetCurrentTimeline() or nil
  if not tl then
    local name, taken, n = a.name, timelinesByName(p), 2
    while taken[name] do name = a.name .. ' ' .. n; n = n + 1 end
    tl = mp:CreateEmptyTimeline(name)
    if not tl then return { ok = false, error = 'could not create timeline ' .. name } end
  end
  p:SetCurrentTimeline(tl)
  local placed = mp:AppendToTimeline({ clip })
  if not placed or #placed == 0 then return { ok = false, error = 'could not place the file on timeline ' .. tl:GetName() } end
  -- Voice Isolation on the clip's audio track (track FX, as in the Mixer); a miss is a warning, the clip is in
  local track, warning
  if a.isolation then
    for _, item in ipairs(placed) do
      local ti = item:GetTrackTypeAndIndex()
      if ti and ti[1] == 'audio' then track = ti[2]; break end
    end
    local called, done = false, false
    if track then
      called, done = pcall(function() return tl:SetVoiceIsolationState(track, { isEnabled = true, amount = a.isolation }) end)
    end
    if not (called and done) then warning = 'could not turn on Voice Isolation (needs Resolve 20 or later)'; track = nil end
  end
  r:OpenPage('fairlight')
  return { ok = true, timeline = tl:GetName(), bin = a.bin, clip = clip:GetName(), isolationTrack = track, warning = warning }
end

local function jobstatus(a)
  if a.token then
    local owned, err = encowned(a)
    if not owned then return { ok = false, fatal = true, error = err } end
  end
  local _, p = project()
  if not p then return { ok = false, error = 'No project open' } end
  local s = p:GetRenderJobStatus(a.id)
  if not s then return { ok = false, error = 'job not found' } end
  local res = { ok = true, status = s.JobStatus, percent = s.CompletionPercentage, tookMs = s.TimeTakenToRenderInMs, error = s.Error }
  for _, j in ipairs(p:GetRenderJobList() or {}) do
    if j.JobId == a.id then res.dir = j.TargetDir; res.file = j.OutputFilename end
  end
  return res
end

-- Night queue: start chosen jobs of the open project's render queue.
local function startrender(a)
  local _, p = project()
  if not p then return { ok = false, error = 'No project open' } end
  if p:IsRenderingInProgress() then return { ok = false, error = 'Resolve is already rendering' } end
  local have, ids, missing = {}, {}, {}
  for _, j in ipairs(p:GetRenderJobList() or {}) do have[j.JobId] = true end
  for _, id in ipairs(a.ids or {}) do
    if have[id] then ids[#ids + 1] = id else missing[#missing + 1] = id end
  end
  if #ids == 0 then return { ok = false, error = 'None of the chosen render jobs are in the render queue any more' } end
  if not p:StartRendering(ids, false) then return { ok = false, error = 'Resolve did not start rendering' } end
  return { ok = true, started = #ids, missing = #missing }
end

local function stoprender()
  local _, p = project()
  if p then p:StopRendering() end
  return { ok = true }
end

---------------------------------------------------------------- main loop
local stabilize, premiere
reply({ ok = true, ready = true })
while true do
  local line = io.read('*l')
  if not line then break end
  line = line:gsub('^\239\187\191', ''):gsub('[\r\n]', '')
  if line == 'quit' then break end
  local cmd, arg = line:match('^%s*(%w+)\t?(.*)$')
  if cmd then
    local ok, res = pcall(function()
      if encoderSession and (cmd == 'setup' or cmd == 'series' or cmd == 'rename' or cmd == 'detect' or cmd == 'hdbatch' or cmd == 'hdcleanup' or cmd == 'chainimport' or cmd == 'save' or cmd == 'export' or cmd == 'startrender') then
        return { ok = false, error = 'Finish Encoder before modifying or backing up a project' }
      end
      if cmd == 'status' then return status()
      elseif cmd == 'clipinfo' then return clipinfo()
      elseif cmd == 'stabilize' then
        if encoderSession then return {ok=false,error='Finish Encoder first'} end
        stabilize = stabilize or dofile('stabilization.lua')(connect, array)
        return stabilize(parse(arg))
      elseif cmd == 'premiere' then
        if encoderSession then return {ok=false,error='Finish Encoder first'} end
        premiere = premiere or dofile('premiere.lua')(connect, array)
        return premiere(parse(arg))
      elseif cmd == 'export' then return export(arg)
      elseif cmd == 'save' then return save()
      elseif cmd == 'setup' then return setup(parse(arg))
      elseif cmd == 'series' then return series(parse(arg))
      elseif cmd == 'barsstill' then return barsstill(parse(arg))
      elseif cmd == 'timelines' then return timelines()
      elseif cmd == 'rename' then return rename(parse(arg))
      elseif cmd == 'detect' then return detect(parse(arg))
      elseif cmd == 'presets' then return presets()
      elseif cmd == 'hdbatch' then return hdbatch(parse(arg))
      elseif cmd == 'hdcleanup' then return hdcleanup(parse(arg))
      elseif cmd == 'encstart' then return encstart(parse(arg))
      elseif cmd == 'encbegin' then return encbegin(parse(arg))
      elseif cmd == 'encfinish' then return encfinish(parse(arg))
      elseif cmd == 'jobstatus' then return jobstatus(parse(arg))
      elseif cmd == 'stoprender' then return stoprender()
      elseif cmd == 'startrender' then return startrender(parse(arg))
      elseif cmd == 'chainimport' then return chainimport(parse(arg))
      else return { ok = false, error = 'unknown command: ' .. cmd } end
    end)
    if not ok then res = { ok = false, error = tostring(res) } end
    reply(res)
  end
end
