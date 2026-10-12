# Confirms Premiere's informational "Load Project" notice (missing plugins/fonts), which
# blocks scripting while open. Other dialogs are only reported, never touched.
param([int]$ProcessId = 0)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace PP -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'
$A = [System.Windows.Automation.AutomationElement]
$procs = if ($ProcessId) { @($ProcessId) } else { @(Get-Process 'Adobe Premiere Pro' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
$out = @()
foreach ($procId in $procs) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $procId)
  foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
    $windows = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    foreach ($d in @($w) + @($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $windows))) {
      $name = $d.Current.Name
      if ($name -like 'Adobe Premiere Pro*' -or -not $name) { continue }
      if ($name -eq 'Load Project' -and $d.Current.ClassName -eq '#32770') {
        # WM_CLOSE: same as its X button; this notice only informs
        [void][PP.Win]::PostMessage([System.IntPtr]$d.Current.NativeWindowHandle, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
        $out += "pressed:$name"
      } else { $out += "seen:$name" }
    }
  }
}
$out -join "`n"
