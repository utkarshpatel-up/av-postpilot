local r = bmd.scriptapp('Resolve', 'localhost'); local p = r:GetProjectManager():GetCurrentProject()
for k, v in pairs(p:GetRenderFormats()) do local codecs = {}; for ck, cv in pairs(p:GetRenderCodecs(v) or {}) do codecs[#codecs+1] = ck .. '=' .. cv end; print(k, v, table.concat(codecs, '; ')) end
