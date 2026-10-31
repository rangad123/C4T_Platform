/**
 * The PowerShell side of Windows desktop tests: one long-lived, hidden `powershell.exe -NoProfile -NonInteractive -STA` per
 * test that speaks JSON lines over stdin/stdout (one request per line, one answer per line, ASCII only on the wire).
 *
 * What it may do, and nothing else:
 *  - start ONE program (the path the caller already checked against the allow-list and the deny-list; checked again here)
 *    with `System.Diagnostics.Process.Start`, `UseShellExecute = false`: no shell, no composed command string;
 *  - look at the top-level windows that belong to THAT process id, and their descendants (it never enumerates other
 *    applications' windows);
 *  - act on elements through UI Automation patterns only: Invoke, Value, SelectionItem, Toggle, ExpandCollapse. It never
 *    sends mouse or keyboard input, never moves the cursor, never brings a window to the front;
 *  - take a picture of the application's own window (PrintWindow: the window's pixels, not the desktop's);
 *  - close the application, and every process of its tree, when asked, when its input closes, and at exit.
 * All values from the test arrive as JSON data and are only ever used as .NET method arguments or property values. The text
 * of the script contains no value from a test: nothing here is built by pasting test text into code.
 *
 * Password-type controls (IsPassword) are never read: their name and value are reported as [hidden].
 *
 * PowerShell here is Windows PowerShell 5.1. Keep the text free of backticks and of "${" (it lives in a template literal)
 * and of the word that the generated-script secrecy tests forbid.
 */
import { DESKTOP_CONTROL_TYPES, DESKTOP_DENIED_PROGRAMS } from "./target.js";

const psList = (items: readonly string[]): string => items.map((x) => `'${x.replace(/[^A-Za-z0-9_]/g, "")}'`).join(",");

export const UIA_HOST_SCRIPT = String.raw`# aitp-uia-host
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:appPid = 0
$script:proc = $null
$script:orphans = New-Object System.Collections.ArrayList
$script:shot = $null
$deniedPrograms = @(${psList(DESKTOP_DENIED_PROGRAMS)})
$controlNames = @(${psList(DESKTOP_CONTROL_TYPES)})

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$ser = $null
function Send($obj) {
    $json = $ser.Serialize($obj)
    $json = [regex]::Replace($json, '[^\u0000-\u007F]', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) (([string][char]92) + 'u' + ('{0:x4}' -f [int][char]$m.Value)) })
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Web.Extensions
    Add-Type -AssemblyName System.Drawing
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = 67108864
} catch {
    $ser = $null
    [Console]::Out.WriteLine('{"ready":false,"error":"Windows UI Automation could not be loaded on this computer."}')
    [Console]::Out.Flush()
    exit 3
}

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$ControlTypes = @{}
foreach ($n in $controlNames) { $ControlTypes[$n] = [System.Windows.Automation.ControlType].GetField($n).GetValue($null) }

function Fail($code, $message) { return @{ ok = $false; code = $code; error = $message } }
function Field($d, $k) { if ($d -ne $null -and $d.ContainsKey($k)) { return $d[$k] } return $null }
function Cond($prop, $val) { return New-Object System.Windows.Automation.PropertyCondition($prop, $val) }

# The ledger lists every process this helper starts (and itself), so the caller can make sure none is left behind.
function Ledger($kind, $p) {
    $file = $env:AITP_UIA_LEDGER
    if (-not $file) { return }
    try {
        $line = $ser.Serialize(@{ kind = $kind; pid = [int]$p.Id; start = [string]$p.StartTime.ToFileTimeUtc() })
        [System.IO.File]::AppendAllText($file, $line + [Environment]::NewLine)
    } catch { }
}

function Quote-Arg([string]$a) {
    if ($a -eq '') { return '""' }
    if ($a -notmatch '[\s"]') { return $a }
    $s = $a -replace '(\\*)"', '$1$1\"'
    $s = $s -replace '(\\+)$', '$1$1'
    return '"' + $s + '"'
}

function Get-AppWindows {
    $list = New-Object System.Collections.ArrayList
    if ($script:appPid -le 0) { return ,$list }
    try {
        $found = $AE::RootElement.FindAll($TS::Children, (Cond ([System.Windows.Automation.AutomationElement]::ProcessIdProperty) ([int]$script:appPid)))
        foreach ($w in $found) { [void]$list.Add($w) }
    } catch { }
    return ,$list
}

function Find-Els($loc) {
    $conds = New-Object System.Collections.ArrayList
    $id = Field $loc 'automationId'
    if ($id -ne $null) { [void]$conds.Add((Cond ([System.Windows.Automation.AutomationElement]::AutomationIdProperty) ([string]$id))) }
    $ct = Field $loc 'controlType'
    if ($ct) {
        if (-not $ControlTypes.ContainsKey([string]$ct)) { throw 'Unknown control type.' }
        [void]$conds.Add((Cond ([System.Windows.Automation.AutomationElement]::ControlTypeProperty) $ControlTypes[[string]$ct]))
    }
    $name = Field $loc 'name'
    $contains = $false
    if ($name -ne $null) {
        if ((Field $loc 'nameMatch') -eq 'contains') { $contains = $true } else { [void]$conds.Add((Cond ([System.Windows.Automation.AutomationElement]::NameProperty) ([string]$name))) }
    }
    if ($conds.Count -eq 0) { $cond = [System.Windows.Automation.Condition]::TrueCondition }
    elseif ($conds.Count -eq 1) { $cond = $conds[0] }
    else { $cond = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]$conds.ToArray()) }
    $result = New-Object System.Collections.ArrayList
    $seen = @{}
    foreach ($w in (Get-AppWindows)) {
        try { $all = $w.FindAll($TS::Subtree, $cond) } catch { continue }
        foreach ($e in $all) {
            $key = ''
            try { $key = ($e.GetRuntimeId() -join '.') } catch { continue }
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = 1
            if ($contains) {
                $n = ''
                try { $n = [string]$e.Current.Name } catch { continue }
                if ($n.IndexOf([string]$name, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
            }
            [void]$result.Add($e)
        }
    }
    return ,$result
}

function Describe-El($e) {
    $c = $e.Current
    $pw = $false
    try { $pw = [bool]$c.IsPassword } catch { }
    $type = ''
    try { $type = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType\.', '' } catch { }
    $nm = ''
    if ($pw) { $nm = '[hidden]' } else { $nm = [string]$c.Name }
    if ($nm.Length -gt 400) { $nm = $nm.Substring(0, 400) }
    $o = @{ type = $type; automationId = [string]$c.AutomationId; name = $nm; isPassword = $pw; enabled = [bool]$c.IsEnabled; offscreen = [bool]$c.IsOffscreen }
    if (-not $pw) {
        $vp = $null
        if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
            $v = [string]$vp.Current.Value
            if ($v.Length -gt 4000) { $v = $v.Substring(0, 4000) }
            $o['value'] = $v
            $o['readOnly'] = [bool]$vp.Current.IsReadOnly
        }
    }
    $tp = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) { $o['toggle'] = [string]$tp.Current.ToggleState }
    $sp = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) { $o['selected'] = [bool]$sp.Current.IsSelected }
    return $o
}

# Returns @{ el = element } or @{ fail = answer }.
function Resolve-One($req) {
    $loc = Field $req 'locator'
    $els = Find-Els $loc
    $nth = Field $loc 'nth'
    if ($els.Count -eq 0) { return @{ fail = (Fail 'notfound' 'No element matches.') } }
    if ($nth -eq $null) {
        if ($els.Count -gt 1) { return @{ fail = (@{ ok = $false; code = 'ambiguous'; count = $els.Count; error = ('' + $els.Count + ' elements match.') }) } }
        return @{ el = $els[0] }
    }
    if ([int]$nth -ge $els.Count) { return @{ fail = (Fail 'notfound' ('There are only ' + $els.Count + ' matching elements.')) } }
    return @{ el = $els[[int]$nth] }
}

# Invoke can block until a dialog it opens is closed, so it runs on another thread and we wait a little.
function Invoke-Async($el) {
    $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $rs.ApartmentState = [System.Threading.ApartmentState]::MTA
    $rs.Open()
    $ps = [System.Management.Automation.PowerShell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript({ param($el) $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke() }).AddArgument($el)
    $h = $ps.BeginInvoke()
    if ($h.AsyncWaitHandle.WaitOne(2500)) {
        try { [void]$ps.EndInvoke($h) } finally { $ps.Dispose(); $rs.Dispose() }
        return $true
    }
    [void]$script:orphans.Add(@($ps, $rs))
    return $false
}

function Stop-App {
    $p = $script:proc
    if ($p -eq $null) { return }
    try { if (-not $p.HasExited) { [void]$p.CloseMainWindow(); [void]$p.WaitForExit(3000) } } catch { }
    try { if (-not $p.HasExited) { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $p.Id /T /F 2>&1 | Out-Null } } catch { }
    try { [void]$p.WaitForExit(3000) } catch { }
    $script:proc = $null
    $script:appPid = 0
}

function Walk-Tree($el, $depth, $lines, $state) {
    if ($state.n -ge 80) { $state.more++; return }
    $c = $el.Current
    $pw = $false
    try { $pw = [bool]$c.IsPassword } catch { }
    $type = ''
    try { $type = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType\.', '' } catch { }
    $nm = ''
    if ($pw) { $nm = '[hidden]' } else { $nm = [string]$c.Name }
    if ($nm.Length -gt 60) { $nm = $nm.Substring(0, 60) }
    [void]$lines.Add(@{ d = $depth; t = $type; i = [string]$c.AutomationId; n = $nm; p = $pw })
    $state.n++
    if ($depth -ge 4) { return }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $null
    try { $child = $walker.GetFirstChild($el) } catch { return }
    while ($child -ne $null) {
        Walk-Tree $child ($depth + 1) $lines $state
        try { $child = $walker.GetNextSibling($child) } catch { break }
    }
}

function Take-Shot($win) {
    $hwnd = [IntPtr]::Zero
    try { $hwnd = [IntPtr][int]$win.Current.NativeWindowHandle } catch { }
    if ($hwnd -eq [IntPtr]::Zero) { return (Fail 'noshot' 'The window has no handle to take a picture of.') }
    if ($script:shot -eq $null) {
        $src = 'using System; using System.Drawing; using System.Drawing.Imaging; using System.IO; using System.Runtime.InteropServices; public static class AitpShot { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags); [DllImport("user32.dll")] static extern bool SetProcessDPIAware(); public static string Capture(IntPtr h, out int w, out int ht) { SetProcessDPIAware(); RECT r; if (!GetWindowRect(h, out r)) throw new Exception("no window rectangle"); w = r.R - r.L; ht = r.B - r.T; if (w <= 0 || ht <= 0 || w > 8000 || ht > 8000) throw new Exception("window size not usable"); using (Bitmap bmp = new Bitmap(w, ht, PixelFormat.Format32bppArgb)) { using (Graphics g = Graphics.FromImage(bmp)) { IntPtr hdc = g.GetHdc(); bool ok; try { ok = PrintWindow(h, hdc, 2); } finally { g.ReleaseHdc(hdc); } if (!ok) throw new Exception("PrintWindow failed"); } using (MemoryStream ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return Convert.ToBase64String(ms.ToArray()); } } } }'
        try { Add-Type -TypeDefinition $src -ReferencedAssemblies 'System.Drawing' -ErrorAction Stop; $script:shot = $true } catch { $script:shot = $false }
    }
    if ($script:shot) {
        try {
            $w = 0; $h = 0
            $b64 = [AitpShot]::Capture($hwnd, [ref]$w, [ref]$h)
            return @{ ok = $true; png = $b64; width = $w; height = $h; how = 'window' }
        } catch { }
    }
    # Fallback: copy the window's rectangle from the screen (anything drawn over it would show).
    try {
        $r = $win.Current.BoundingRectangle
        $w = [int]$r.Width; $h = [int]$r.Height
        if ($w -le 0 -or $h -le 0 -or $w -gt 8000 -or $h -gt 8000) { return (Fail 'noshot' 'The window size is not usable for a picture.') }
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $b64 = [Convert]::ToBase64String($ms.ToArray())
        $bmp.Dispose()
        return @{ ok = $true; png = $b64; width = $w; height = $h; how = 'screen' }
    } catch {
        return (Fail 'noshot' 'A picture of the window could not be taken.')
    }
}

function Handle($req) {
    $cmd = [string](Field $req 'cmd')
    switch ($cmd) {
        'launch' {
            if ($script:proc -ne $null) { return (Fail 'state' 'An application is already running in this session.') }
            $path = [string](Field $req 'path')
            if ($path -notmatch '^[A-Za-z]:\\' -or $path -notmatch '\.exe$' -or $path -match '\.\.' -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return (Fail 'refused' 'The application is not a program file on this computer.') }
            $leaf = [System.IO.Path]::GetFileNameWithoutExtension($path).ToLowerInvariant()
            if ($deniedPrograms -contains $leaf) { return (Fail 'refused' 'That program is never started by a test.') }
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $path
            $parts = @()
            foreach ($a in @(Field $req 'args')) { if ($a -ne $null) { $parts += (Quote-Arg ([string]$a)) } }
            $psi.Arguments = ($parts -join ' ')
            $psi.UseShellExecute = $false
            $psi.WorkingDirectory = [System.IO.Path]::GetDirectoryName($path)
            # The application under test does not need this run's credentials or settings.
            foreach ($k in @($psi.EnvironmentVariables.Keys)) { if ($k -match '^(TEST_|AITP_|API_|BASE_URL|PW_|LLM_|SECRET_)') { $psi.EnvironmentVariables.Remove($k) } }
            $timeout = 15000
            $t = Field $req 'timeoutMs'
            if ($t -ne $null) { $timeout = [int]$t }
            $title = Field $req 'windowTitle'
            $p = [System.Diagnostics.Process]::Start($psi)
            $script:proc = $p
            $script:appPid = $p.Id
            Ledger 'app' $p
            try { [void]$p.WaitForInputIdle([Math]::Min($timeout, 5000)) } catch { }
            $deadline = [DateTime]::UtcNow.AddMilliseconds($timeout)
            while ($true) {
                if ($p.HasExited) { $code = $p.ExitCode; $script:proc = $null; $script:appPid = 0; return (Fail 'exited' ('The application closed right after it started (exit code ' + $code + ').')) }
                $wins = Get-AppWindows
                foreach ($w in $wins) {
                    $wn = ''
                    try { $wn = [string]$w.Current.Name } catch { continue }
                    if ($title -eq $null -or $wn.IndexOf([string]$title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return @{ ok = $true; pid = $p.Id; window = $wn } }
                }
                if ([DateTime]::UtcNow -gt $deadline) {
                    $what = 'The application did not open a window'
                    if ($title -ne $null) { $what = 'The application did not open a window whose title contains that text' }
                    return (Fail 'timeout' ($what + ' within ' + [int]($timeout / 1000) + ' seconds.'))
                }
                Start-Sleep -Milliseconds 100
            }
        }
        'state' {
            $els = Find-Els (Field $req 'locator')
            $out = @{ ok = $true; count = $els.Count }
            if ($els.Count -gt 0) {
                $nth = Field (Field $req 'locator') 'nth'
                $i = 0
                if ($nth -ne $null) { $i = [int]$nth }
                if ($i -lt $els.Count) { $out['element'] = (Describe-El $els[$i]) }
            }
            return $out
        }
        'click' {
            $r = Resolve-One $req
            if ($r.fail) { return $r.fail }
            $el = $r.el
            $d = Describe-El $el
            if (-not $d.enabled) { return (Fail 'disabled' 'The element is disabled.') }
            if ($d.offscreen) { return (Fail 'offscreen' 'The element is not on screen.') }
            $p = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
                $done = Invoke-Async $el
                if ($done) { return @{ ok = $true } }
                return @{ ok = $true; note = 'The application did not answer within 2.5 seconds after the click (it may be showing a dialog).' }
            }
            if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return @{ ok = $true } }
            if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return @{ ok = $true } }
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
                if ($p.Current.ExpandCollapseState -eq 'Collapsed') { $p.Expand() } else { $p.Collapse() }
                return @{ ok = $true }
            }
            return (Fail 'unsupported' 'This element cannot be clicked without the mouse: it does not support Invoke, Select or Toggle.')
        }
        'type' {
            $r = Resolve-One $req
            if ($r.fail) { return $r.fail }
            $el = $r.el
            if (-not $el.Current.IsEnabled) { return (Fail 'disabled' 'The element is disabled.') }
            $p = $null
            if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { return (Fail 'unsupported' 'This element does not accept text through UI Automation (no Value support). Desktop tests never type with the keyboard.') }
            if ($p.Current.IsReadOnly) { return (Fail 'unsupported' 'This element is read-only.') }
            $p.SetValue([string](Field $req 'text'))
            return @{ ok = $true }
        }
        'select' {
            $r = Resolve-One $req
            if ($r.fail) { return $r.fail }
            $el = $r.el
            if (-not $el.Current.IsEnabled) { return (Fail 'disabled' 'The element is disabled.') }
            $wanted = [string](Field $req 'value')
            $d = Describe-El $el
            $p = $null
            if (@('ListItem','RadioButton','TabItem','MenuItem','TreeItem','DataItem') -contains $d.type) {
                if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return @{ ok = $true } }
                if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return @{ ok = $true } }
                return (Fail 'unsupported' 'This item cannot be selected without the mouse.')
            }
            $ec = $null
            $expanded = $false
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) {
                try { if ($ec.Current.ExpandCollapseState -eq 'Collapsed') { $ec.Expand(); $expanded = $true; Start-Sleep -Milliseconds 200 } } catch { }
            }
            $item = $null
            $cond = [System.Windows.Automation.AndCondition]::new((Cond ([System.Windows.Automation.AutomationElement]::ControlTypeProperty) $ControlTypes['ListItem']), (Cond ([System.Windows.Automation.AutomationElement]::NameProperty) $wanted))
            try { $found = $el.FindAll($TS::Descendants, $cond); if ($found.Count -gt 0) { $item = $found[0] } } catch { }
            if ($item -eq $null) {
                foreach ($w in (Get-AppWindows)) { try { $found = $w.FindAll($TS::Subtree, $cond); if ($found.Count -gt 0) { $item = $found[0]; break } } catch { } }
            }
            $done = $false
            if ($item -ne $null -and $item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); $done = $true }
            elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and -not $p.Current.IsReadOnly -and $item -eq $null) { $p.SetValue($wanted); $done = $true }
            if ($expanded) { try { $ec.Collapse() } catch { } }
            if ($done) { return @{ ok = $true } }
            return (Fail 'noitem' 'The list has no such item.')
        }
        'toggle' {
            $r = Resolve-One $req
            if ($r.fail) { return $r.fail }
            $el = $r.el
            if (-not $el.Current.IsEnabled) { return (Fail 'disabled' 'The element is disabled.') }
            $want = [bool](Field $req 'checked')
            $p = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
                $target = 'Off'
                if ($want) { $target = 'On' }
                for ($i = 0; $i -lt 3; $i++) {
                    if ([string]$p.Current.ToggleState -eq $target) { return @{ ok = $true } }
                    $p.Toggle()
                }
                if ([string]$p.Current.ToggleState -eq $target) { return @{ ok = $true } }
                return (Fail 'state' 'The element did not reach the wanted state.')
            }
            if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
                if ($want) { $p.Select(); return @{ ok = $true } }
                return (Fail 'unsupported' 'A radio button cannot be unchecked directly. Select another option instead.')
            }
            return (Fail 'unsupported' 'This element is not a check box or radio button (no Toggle or Select support).')
        }
        'tree' {
            $lines = New-Object System.Collections.ArrayList
            $state = @{ n = 0; more = 0 }
            foreach ($w in (Get-AppWindows)) { Walk-Tree $w 0 $lines $state }
            return @{ ok = $true; nodes = $lines.ToArray(); more = $state.more }
        }
        'screenshot' {
            $wins = Get-AppWindows
            if ($wins.Count -eq 0) { return (Fail 'noshot' 'The application has no window to take a picture of.') }
            return (Take-Shot $wins[0])
        }
        'alive' {
            $alive = ($script:proc -ne $null)
            if ($alive) { try { $alive = -not $script:proc.HasExited } catch { $alive = $false } }
            return @{ ok = $true; alive = $alive }
        }
        'close' { Stop-App; return @{ ok = $true } }
        'exit' { return @{ ok = $true } }
        'hello' {
            $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
            $admin = ([System.Security.Principal.WindowsPrincipal]$id).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
            return @{ ok = $true; elevated = [bool]$admin; interactive = [bool][Environment]::UserInteractive }
        }
        default { return (Fail 'badcmd' 'Unknown command.') }
    }
}

try { Ledger 'host' (Get-Process -Id $PID) } catch { }
$idNow = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([System.Security.Principal.WindowsPrincipal]$idNow).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
Send @{ ready = $true; elevated = [bool]$isAdmin; interactive = [bool][Environment]::UserInteractive }
try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($line -eq $null) { break }
        if ($line.Trim() -eq '') { continue }
        $reqId = 0
        $cmdName = ''
        try {
            $req = $ser.DeserializeObject($line)
            $reqId = Field $req 'id'
            $cmdName = [string](Field $req 'cmd')
            $out = @(Handle $req | Where-Object { $_ -is [hashtable] })
            $res = $out[$out.Count - 1]
            if ($res -eq $null) { $res = Fail 'error' 'The helper gave no answer.' }
        } catch {
            $res = Fail 'error' ('The UI Automation helper hit a problem: ' + $_.Exception.Message)
        }
        $res['id'] = $reqId
        Send $res
        if ($cmdName -eq 'exit') { break }
    }
} finally {
    Stop-App
}
`;
