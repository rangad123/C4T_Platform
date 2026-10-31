# Builds the Windows desktop test fixture: a small desktop application compiled to a real .exe with the C# compiler that ships
# with Windows (nothing is downloaded, nothing is installed).
#
#   powershell -NoProfile -File tests/fixtures/winforms-app.ps1 -OutDir <folder>     -> prints the path of AitpFixture.exe
#
# Why an .exe and not "a PowerShell script that shows a window": the platform never starts powershell.exe for a test (it is on the
# hard deny-list), so the application under test must be a program of its own.
#
# Why WPF controls in a file called winforms-app: plain .NET Framework WinForms buttons and text boxes reach UI Automation only through
# the old MSAA bridge, as anonymous panes with no Invoke or Value support (checked on this machine), so a pattern-only driver cannot
# act on them. WPF controls publish real UI Automation providers, like the desktop applications this feature is meant for. The file
# name is kept because the brief and the tests refer to it.
#
# The window (title "AITP Fixture", or --title=<text>):
#   btnAdd "Add one"        increments lblCount "Count: N"
#   txtName + btnGreet      lblGreeting "Hello, <name>!"
#   txtSecret (password)    btnSecretLen shows lblSecretLen "Secret length: N" (the secret itself is never shown anywhere)
#   chkNews "Subscribe"     lblNews "Subscribed: yes|no"
#   lstColors (Red, Green, Blue)   lblColor "Color: <choice>"
#   cmbSize (Small, Medium, Large) lblSize "Size: <choice>"
#   btnHide "Hide message"  removes lblTemp "Temporary message" from view
#   btnDialog "Open dialog" opens a modal window "AITP Dialog" (a second top-level window) with an OK button
#   --echo=<text>           shows "Echo: <text>" in lblEcho (proves how arguments reach a program)
#   --exit-after=<seconds>  closes the window by itself after that long (so a forgotten window cannot stay open)
param(
    [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Threading;

public static class AitpFixture
{
    static T Id<T>(T c, string id, string name) where T : FrameworkElement
    {
        AutomationProperties.SetAutomationId(c, id);
        if (name != null) AutomationProperties.SetName(c, name);
        return c;
    }

    [STAThread]
    public static int Main(string[] args)
    {
        string title = "AITP Fixture";
        string echo = "";
        int exitAfter = 0;
        foreach (string a in args)
        {
            if (a.StartsWith("--title=")) title = a.Substring(8);
            else if (a.StartsWith("--echo=")) echo = a.Substring(7);
            else if (a.StartsWith("--exit-after=")) int.TryParse(a.Substring(13), out exitAfter);
        }

        Window w = new Window();
        w.Title = title;
        w.Width = 460; w.Height = 600;
        w.WindowStartupLocation = WindowStartupLocation.Manual;
        w.Left = 60; w.Top = 60;
        w.ResizeMode = ResizeMode.NoResize;

        StackPanel root = new StackPanel();
        root.Margin = new Thickness(10);
        w.Content = root;

        Func<string, string, TextBlock> label = delegate(string id, string text) { TextBlock t = new TextBlock(); t.Text = text; t.Margin = new Thickness(0, 4, 0, 4); return Id(t, id, null); };

        TextBlock lblCount = label("lblCount", "Count: 0");
        Button btnAdd = Id(new Button(), "btnAdd", null); btnAdd.Content = "Add one"; btnAdd.Width = 100;
        int count = 0;
        btnAdd.Click += delegate { count++; lblCount.Text = "Count: " + count; };
        root.Children.Add(lblCount); root.Children.Add(btnAdd);

        TextBox txtName = Id(new TextBox(), "txtName", "Name field"); txtName.Width = 150; txtName.Margin = new Thickness(0, 8, 0, 4);
        Button btnGreet = Id(new Button(), "btnGreet", null); btnGreet.Content = "Greet"; btnGreet.Width = 100;
        TextBlock lblGreeting = label("lblGreeting", "Hello, nobody!");
        btnGreet.Click += delegate { lblGreeting.Text = "Hello, " + txtName.Text + "!"; };
        root.Children.Add(txtName); root.Children.Add(btnGreet); root.Children.Add(lblGreeting);

        PasswordBox txtSecret = Id(new PasswordBox(), "txtSecret", "Secret field"); txtSecret.Width = 150; txtSecret.Margin = new Thickness(0, 8, 0, 4);
        Button btnSecretLen = Id(new Button(), "btnSecretLen", null); btnSecretLen.Content = "Show length"; btnSecretLen.Width = 100;
        TextBlock lblSecretLen = label("lblSecretLen", "Secret length: 0");
        btnSecretLen.Click += delegate { lblSecretLen.Text = "Secret length: " + txtSecret.Password.Length; };
        root.Children.Add(txtSecret); root.Children.Add(btnSecretLen); root.Children.Add(lblSecretLen);

        CheckBox chkNews = Id(new CheckBox(), "chkNews", null); chkNews.Content = "Subscribe"; chkNews.Margin = new Thickness(0, 8, 0, 4);
        TextBlock lblNews = label("lblNews", "Subscribed: no");
        chkNews.Checked += delegate { lblNews.Text = "Subscribed: yes"; };
        chkNews.Unchecked += delegate { lblNews.Text = "Subscribed: no"; };
        root.Children.Add(chkNews); root.Children.Add(lblNews);

        ListBox lstColors = Id(new ListBox(), "lstColors", "Colors"); lstColors.Width = 120; lstColors.Height = 70; lstColors.HorizontalAlignment = HorizontalAlignment.Left; lstColors.Margin = new Thickness(0, 8, 0, 4);
        foreach (string c in new string[] { "Red", "Green", "Blue" }) lstColors.Items.Add(c);
        TextBlock lblColor = label("lblColor", "Color: none");
        lstColors.SelectionChanged += delegate { lblColor.Text = "Color: " + (lstColors.SelectedItem == null ? "none" : lstColors.SelectedItem.ToString()); };
        root.Children.Add(lstColors); root.Children.Add(lblColor);

        ComboBox cmbSize = Id(new ComboBox(), "cmbSize", "Size"); cmbSize.Width = 120; cmbSize.HorizontalAlignment = HorizontalAlignment.Left; cmbSize.Margin = new Thickness(0, 8, 0, 4);
        foreach (string c in new string[] { "Small", "Medium", "Large" }) cmbSize.Items.Add(c);
        TextBlock lblSize = label("lblSize", "Size: none");
        cmbSize.SelectionChanged += delegate { lblSize.Text = "Size: " + (cmbSize.SelectedItem == null ? "none" : cmbSize.SelectedItem.ToString()); };
        root.Children.Add(cmbSize); root.Children.Add(lblSize);

        TextBlock lblTemp = label("lblTemp", "Temporary message");
        Button btnHide = Id(new Button(), "btnHide", null); btnHide.Content = "Hide message"; btnHide.Width = 100;
        btnHide.Click += delegate { lblTemp.Visibility = Visibility.Collapsed; };
        root.Children.Add(lblTemp); root.Children.Add(btnHide);

        Button btnDialog = Id(new Button(), "btnDialog", null); btnDialog.Content = "Open dialog"; btnDialog.Width = 100; btnDialog.Margin = new Thickness(0, 8, 0, 4);
        btnDialog.Click += delegate {
            // A second top-level window of the same program, modal: Invoke on the button above only returns when it is closed.
            Window d = new Window(); d.Title = "AITP Dialog"; d.Owner = w; d.Width = 260; d.Height = 140; d.WindowStartupLocation = WindowStartupLocation.CenterOwner;
            StackPanel sp = new StackPanel(); sp.Margin = new Thickness(10);
            sp.Children.Add(new TextBlock { Text = "The dialog is open." });
            Button ok = Id(new Button(), "btnDialogOk", null); ok.Content = "OK"; ok.Width = 80; ok.Margin = new Thickness(0, 10, 0, 0); ok.Click += delegate { d.Close(); };
            sp.Children.Add(ok); d.Content = sp; d.ShowDialog();
        };
        root.Children.Add(btnDialog); root.Children.Add(label("lblEcho", "Echo: " + echo));

        if (exitAfter > 0)
        {
            DispatcherTimer t = new DispatcherTimer();
            t.Interval = TimeSpan.FromSeconds(exitAfter);
            t.Tick += delegate { t.Stop(); w.Close(); };
            t.Start();
        }
        return new Application().Run(w);
    }
}
'@

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$exe = Join-Path $OutDir 'AitpFixture.exe'
if (Test-Path -LiteralPath $exe) { Remove-Item -LiteralPath $exe -Force }
$cp = New-Object System.CodeDom.Compiler.CompilerParameters
$cp.GenerateExecutable = $true
$cp.OutputAssembly = $exe
$cp.CompilerOptions = '/target:winexe'
# The WPF assemblies are referenced by their files in the .NET Framework folder (always present on Windows).
$wpf = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/WPF'
foreach ($a in 'System.dll', 'System.Core.dll', 'System.Xaml.dll') { [void]$cp.ReferencedAssemblies.Add($a) }
foreach ($n in 'WindowsBase', 'PresentationCore', 'PresentationFramework') { [void]$cp.ReferencedAssemblies.Add((Join-Path $wpf ($n + '.dll'))) }
Add-Type -TypeDefinition $source -CompilerParameters $cp
Write-Output $exe
