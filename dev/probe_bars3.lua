local r = bmd.scriptapp('Resolve', 'localhost')
local p = r:GetProjectManager():GetCurrentProject()
local mp = p:GetMediaPool()
-- 1. make a bars still from Resolve's generator
local tmp = mp:CreateEmptyTimeline('BarsStill ' .. os.time()); p:SetCurrentTimeline(tmp)
tmp:InsertGeneratorIntoTimeline('SMPTE Color Bar')
r:OpenPage('color'); bmd.wait(1.5)
tmp:SetCurrentTimecode(tmp:GetStartTimecode()); bmd.wait(1)
local still = [[C:\Users\admin\Downloads\av-postpilot\dev\bars_still.png]]
print('still', p:ExportCurrentFrameAsStill(still))
r:OpenPage('edit')
-- 2. title with the still behind the text
local tl = mp:CreateEmptyTimeline('BarsTitle ' .. os.time()); p:SetCurrentTimeline(tl)
local item = tl:InsertFusionTitleIntoTimeline('Text+')
local comp = item:GetFusionCompByIndex(1)
local tp = comp:GetToolList(false, 'TextPlus')[1]
local out = comp:GetToolList(false, 'MediaOut')[1]
print('tools', tp and tp.Name, out and out.Name)
tp:SetInput('StyledText', 'DD Vitraag - 8912\n(Adalaj)'); tp:SetInput('Font', 'Calibri'); tp:SetInput('Style', 'Bold'); tp:SetInput('Size', 0.11)
tp:SetInput('Center', { 0.5, 0.6 })
comp:Lock()
local loader = comp:AddTool('Loader', -32768, -32768)
loader.Clip = still
local merge = comp:AddTool('Merge', -32768, -32768)
merge.Background = loader.Output
merge.Foreground = tp.Output
out.Input = merge.Output
comp:Unlock()
print('loader', loader and loader.Name, 'merge', merge and merge.Name)
r:OpenPage('color'); bmd.wait(1.5)
tl:SetCurrentTimecode(tl:GetStartTimecode()); bmd.wait(1.5)
print('check still', p:ExportCurrentFrameAsStill([[C:\Users\admin\Downloads\av-postpilot\dev\bars_title.png]]))
r:OpenPage('edit')
