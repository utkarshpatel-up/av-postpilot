-- Dev: close and delete Resolve project arg[1] (test projects only).
local r = bmd.scriptapp('Resolve', 'localhost'); local pm = r:GetProjectManager(); local p = pm:GetCurrentProject()
if p and p:GetName() == arg[1] then print('close', pm:CloseProject(p)) end
print('delete', pm:DeleteProject(arg[1]))
print('now', pm:GetCurrentProject() and pm:GetCurrentProject():GetName())
