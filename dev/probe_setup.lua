local r = bmd.scriptapp('Resolve', 'localhost')
local pm = r:GetProjectManager()
local name = 'PP Probe ' .. os.time()
local p = pm:CreateProject(name)
print('project', p and p:GetName())
local mp = p:GetMediaPool()
local root = mp:GetRootFolder()
local seq = mp:AddSubFolder(root, 'Sequence')
local sf = mp:AddSubFolder(root, 'Satsang Files')
local day = mp:AddSubFolder(sf, 'DayBin')
mp:SetCurrentFolder(day)
local base = [[C:\Users\admin\Downloads\av-postpilot\dev\testsrc\2978 Dt-03 Jun 2026\Adalaj Hindi Shibir Parayan on Hindi Aptavani E. Dt-03-Jun-26 Dur-1h28m Clips-02\]]
local clips = mp:ImportMedia({ base .. 'Adalaj Hindi Shibir Parayan on Hindi Aptavani E. Dt-03-Jun-26 Dur-41m10s Clip-01.MOV',
                               base .. 'Adalaj Hindi Shibir Parayan on Hindi Aptavani E. Dt-03-Jun-26 Dur-47m22s Clip-02.MOV' })
print('imported', clips and #clips)
local c1 = clips[1]
print('clip props', c1:GetClipProperty('Resolution'), c1:GetClipProperty('FPS'), c1:GetName())
print('set fps', p:SetSetting('timelineFrameRate', '25'), p:SetSetting('timelineResolutionWidth','1280'), p:SetSetting('timelineResolutionHeight','720'))
mp:SetCurrentFolder(seq)
local tl = mp:CreateTimelineFromClips('Master-TEST', clips)
print('timeline', tl and tl:GetName(), 'items', #(tl:GetItemListInTrack('video',1) or {}))
for i, it in ipairs(tl:GetItemListInTrack('video',1)) do print('  ', i, it:GetName(), it:GetStart(), it:GetEnd()) end
local dup = tl:DuplicateTimeline('Edit-TEST')
print('dup', dup and dup:GetName())
for i, c in ipairs(seq:GetClipList()) do print('in Sequence bin:', c:GetName()) end
for i, c in ipairs(day:GetClipList()) do print('in Day bin:', c:GetName()) end
-- Text+ title
local ep = mp:AddSubFolder(root, 'Episode')
mp:SetCurrentFolder(ep)
local et = mp:CreateEmptyTimeline('Hindi Shibir-01 (2978)')
p:SetCurrentTimeline(et)
local t = et:InsertFusionTitleIntoTimeline('Text+')
print('title', t and t:GetName(), 'start', t and t:GetStart(), 'end', t and t:GetEnd(), 'comps', t and t:GetFusionCompCount())
local comp = t:GetFusionCompByIndex(1)
local tools = comp:GetToolList(false, 'TextPlus')
local tp = tools[1]
print('textplus', tp and tp.Name)
tp:SetInput('StyledText', 'DD Hindi -\n(Hindi Shibir, Adalaj)')
tp:SetInput('Font', 'Calibri'); tp:SetInput('Style', 'Bold')
print('readback', tp:GetInput('StyledText'), tp:GetInput('Font'), tp:GetInput('Style'), tp:GetInput('Size'))
print('setprop duration', t:SetProperty('Duration', 150))
print('PROJECT', name)
