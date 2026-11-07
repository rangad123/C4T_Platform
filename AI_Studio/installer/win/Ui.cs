// The window and the notification-area (tray) icon. The checklist and the runner supervision live in Engine.cs and RunnerHost.cs; this file
// only shows them and wires the buttons.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace AITestingRunner
{
    sealed class SetupWindow : Form, IReport
    {
        public readonly ListView List = new ListView();
        public readonly ProgressBar Bar = new ProgressBar();
        public readonly Label Headline = new Label(), Sub = new Label(), StatusLine = new Label();
        public readonly CheckBox CbStartup = new CheckBox(), CbMenu = new CheckBox();
        public readonly Button BtnInstall = new Button(), BtnCancel = new Button(), BtnOpen = new Button(), BtnHide = new Button();
        public readonly LinkLabel LinkDetails = new LinkLabel();
        public readonly TextBox LogBox = new TextBox();
        readonly Dictionary<string, ListViewItem> items = new Dictionary<string, ListViewItem>();
        public static readonly Color Teal = Color.FromArgb(0x0b, 0x7a, 0x6e);
        public static readonly Color Ink = Color.FromArgb(0x1b, 0x1f, 0x24);
        public static readonly Color Quiet = Color.FromArgb(0x5a, 0x61, 0x6b);
        public static readonly Color Bad = Color.FromArgb(0xb4, 0x2b, 0x25);
        public static readonly Color Warn = Color.FromArgb(0x9a, 0x62, 0x00);

        public SetupWindow(List<StepRow> rows)
        {
            Text = Product.Name + " setup";
            Font = new Font("Segoe UI", 9f);
            AutoScaleMode = AutoScaleMode.Dpi;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(700, 540);
            ClientSize = new Size(780, 580);
            BackColor = Color.White;
            ForeColor = Ink;
            try { Icon = Icon.ExtractAssociatedIcon(System.Reflection.Assembly.GetExecutingAssembly().Location); } catch (Exception) { }

            TableLayoutPanel root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.ColumnCount = 1;
            root.Padding = new Padding(20, 16, 20, 16);
            root.RowCount = 9;
            for (int i = 0; i < 9; i++) root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles[2] = new RowStyle(SizeType.Percent, 100f);
            Controls.Add(root);

            Headline.Text = "Set up the " + Product.Name;
            Headline.Font = new Font("Segoe UI Semibold", 15f);
            Headline.ForeColor = Teal;
            Headline.AutoSize = true;
            Headline.Margin = new Padding(0, 0, 0, 4);
            Headline.AccessibleName = "Heading";
            root.Controls.Add(Headline, 0, 0);

            Sub.Text = "This checks what your computer already has and only downloads what is missing. It does not need administrator rights.";
            Sub.AutoSize = true;
            Sub.MaximumSize = new Size(720, 0);
            Sub.ForeColor = Quiet;
            Sub.Margin = new Padding(0, 0, 0, 12);
            root.Controls.Add(Sub, 0, 1);

            List.View = View.Details;
            List.FullRowSelect = true;
            List.HideSelection = true;
            List.MultiSelect = false;
            List.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            List.Dock = DockStyle.Fill;
            List.MinimumSize = new Size(100, 190);
            List.Columns.Add("What", 250);
            List.Columns.Add("State", 170);
            List.Columns.Add("Details", 310);
            List.Resize += delegate { int w = List.ClientSize.Width - List.Columns[0].Width - List.Columns[1].Width; if (w > 120) List.Columns[2].Width = w; };
            List.AccessibleName = "Checklist";
            List.BorderStyle = BorderStyle.FixedSingle;
            foreach (StepRow r in rows)
            {
                ListViewItem it = new ListViewItem(r.Name);
                it.UseItemStyleForSubItems = false;
                it.SubItems.Add(r.StateWord());
                it.SubItems.Add(r.Detail);
                List.Items.Add(it);
                items[r.Id] = it;
            }
            root.Controls.Add(List, 0, 2);

            Bar.Dock = DockStyle.Top;
            Bar.Height = 10;
            Bar.Style = ProgressBarStyle.Continuous;
            Bar.Margin = new Padding(0, 10, 0, 0);
            Bar.Visible = false;
            Bar.AccessibleName = "Progress";
            root.Controls.Add(Bar, 0, 3);

            StatusLine.Text = "Checking this computer...";
            StatusLine.AutoSize = true;
            StatusLine.MaximumSize = new Size(720, 0);
            StatusLine.Margin = new Padding(0, 10, 0, 6);
            StatusLine.AccessibleName = "Status";
            root.Controls.Add(StatusLine, 0, 4);

            FlowLayoutPanel opts = new FlowLayoutPanel();
            opts.FlowDirection = FlowDirection.TopDown;
            opts.AutoSize = true;
            opts.WrapContents = false;
            opts.Margin = new Padding(0, 4, 0, 4);
            CbStartup.Text = "Start the runner when I sign in";
            CbMenu.Text = "Add the runner to the Start menu";
            // No browser option: the runner itself uses Chrome or Edge from this computer or downloads a browser, and fetches Firefox and
            // WebKit only when a run needs them.
            foreach (CheckBox c in new CheckBox[] { CbStartup, CbMenu }) { c.AutoSize = true; c.Margin = new Padding(0, 2, 0, 2); c.AccessibleName = c.Text; opts.Controls.Add(c); }
            // Both on by default (round 39): the runner then runs in the background while the person is signed in, with this icon next to
            // the clock as its only visible sign. The person's earlier choice wins when there is one (below).
            CbStartup.Checked = true;
            CbMenu.Checked = true;
            root.Controls.Add(opts, 0, 5);

            LinkDetails.Text = "Show details";
            LinkDetails.AutoSize = true;
            LinkDetails.Margin = new Padding(0, 6, 0, 4);
            LinkDetails.LinkColor = Teal;
            LinkDetails.AccessibleName = "Show or hide the details";
            LinkDetails.LinkClicked += delegate { SetDetails(!LogBox.Visible); };
            root.Controls.Add(LinkDetails, 0, 6);

            LogBox.Multiline = true;
            LogBox.ReadOnly = true;
            LogBox.ScrollBars = ScrollBars.Vertical;
            LogBox.Font = new Font("Consolas", 8.5f);
            LogBox.Dock = DockStyle.Fill;
            LogBox.Height = 120;
            LogBox.Visible = false;
            LogBox.BackColor = Color.FromArgb(0xf6, 0xf7, 0xf8);
            LogBox.AccessibleName = "Details log";
            root.Controls.Add(LogBox, 0, 7);

            FlowLayoutPanel buttons = new FlowLayoutPanel();
            buttons.FlowDirection = FlowDirection.RightToLeft;
            buttons.Dock = DockStyle.Fill;
            buttons.AutoSize = true;
            buttons.Margin = new Padding(0, 10, 0, 0);
            Style(BtnInstall, "Install and start", true);
            Style(BtnCancel, "Cancel", false);
            Style(BtnOpen, "Open the platform", false);
            Style(BtnHide, "Hide window", false);
            BtnCancel.Visible = false;
            BtnOpen.Visible = false;
            BtnHide.Visible = false;
            BtnInstall.Enabled = false;
            buttons.Controls.Add(BtnInstall);
            buttons.Controls.Add(BtnCancel);
            buttons.Controls.Add(BtnOpen);
            buttons.Controls.Add(BtnHide);
            root.Controls.Add(buttons, 0, 8);
            AcceptButton = BtnInstall;

            // The window's handle exists from the start, so a result that arrives while it is hidden can still be shown.
            IntPtr h = Handle;
        }

        static void Style(Button b, string text, bool primary)
        {
            b.Text = text;
            b.AutoSize = true;
            b.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            b.MinimumSize = new Size(110, 32);
            b.Margin = new Padding(8, 0, 0, 0);
            b.FlatStyle = FlatStyle.Flat;
            b.AccessibleName = text;
            if (primary) { b.BackColor = Teal; b.ForeColor = Color.White; b.FlatAppearance.BorderColor = Teal; }
            else { b.BackColor = Color.White; b.ForeColor = Ink; b.FlatAppearance.BorderColor = Color.FromArgb(0xc4, 0xc9, 0xd0); }
        }

        public void SetDetails(bool show)
        {
            LogBox.Visible = show;
            LinkDetails.Text = show ? "Hide details" : "Show details";
        }

        // IReport: safe to call from any thread.
        public void Row(StepRow r)
        {
            if (InvokeRequired) { try { BeginInvoke(new Action<StepRow>(Row), r); } catch (Exception) { } return; }
            ListViewItem it;
            if (!items.TryGetValue(r.Id, out it)) return;
            it.SubItems[1].Text = r.StateWord();
            it.SubItems[2].Text = r.Detail;
            Color c = Ink;
            if (r.State == S.Failed) c = Bad;
            else if (r.State == S.Missing) c = Warn;
            else if (r.State == S.Found || r.State == S.Done) c = Teal;
            it.SubItems[1].ForeColor = c;
            it.SubItems[2].ForeColor = r.State == S.Failed ? Bad : Quiet;
            it.ToolTipText = r.Detail;
            if (r.State == S.Found || r.State == S.Missing || r.State == S.Done || r.State == S.Failed || r.State == S.Skipped || r.State == S.Checked)
                LogBox.AppendText(r.Name + ": " + r.StateWord() + (r.Detail.Length > 0 ? ". " + r.Detail : "") + "\r\n");
            if (r.State == S.Downloading && r.Percent >= 0) { Bar.Visible = true; Bar.Value = Math.Max(0, Math.Min(100, r.Percent)); }
            else if (r.State == S.Installing) { Bar.Visible = true; Bar.Style = ProgressBarStyle.Marquee; }
            else { Bar.Style = ProgressBarStyle.Continuous; if (r.State != S.Downloading) Bar.Visible = false; }
        }

        public void Log(string line)
        {
            if (InvokeRequired) { try { BeginInvoke(new Action<string>(Log), line); } catch (Exception) { } return; }
            if (LogBox.TextLength > 200000) LogBox.Clear();
            LogBox.AppendText(line + "\r\n");
        }

        public void Status(string text)
        {
            if (InvokeRequired) { try { BeginInvoke(new Action<string>(Status), text); } catch (Exception) { } return; }
            StatusLine.Text = text;
        }
    }

    /// <summary>Owns the window, the tray icon and the runner for one run of the program.</summary>
    sealed class UiApp : ApplicationContext
    {
        readonly Options o;
        readonly Layout lay;
        readonly FileLog log;
        readonly Cancel cancel = new Cancel();
        readonly Controller ctl;
        readonly SetupWindow win;
        readonly NotifyIcon tray = new NotifyIcon();
        readonly ContextMenuStrip menu = new ContextMenuStrip();
        readonly ToolStripMenuItem miStatus = new ToolStripMenuItem("Starting"), miOpen = new ToolStripMenuItem("Open the platform in my browser"),
            miShow = new ToolStripMenuItem("Show the window"), miLog = new ToolStripMenuItem("Show log"), miToggle = new ToolStripMenuItem("Stop the runner"),
            miRemove = new ToolStripMenuItem("Remove this runner from the computer"), miQuit = new ToolStripMenuItem("Close this program (stops the runner)");
        readonly Dictionary<RunnerPhase, Icon> icons = new Dictionary<RunnerPhase, Icon>();
        RunnerHost host;
        volatile bool quitting, working;
        bool toldAboutTray, connectedOnce;
        readonly bool smoke;

        public UiApp(Options o, Layout lay, FileLog log, bool smoke)
        {
            this.o = o; this.lay = lay; this.log = log; this.smoke = smoke;
            ctl = null;
            Application.EnableVisualStyles();
            // The controller needs the window as its reporter, and the window needs the controller's rows.
            List<StepRow> rows = new Controller(o, lay, new NullReport(), cancel, log).Rows;
            win = new SetupWindow(rows);
            ctl = new Controller(o, lay, win, cancel, log);
            log.Sink = delegate(string line) { win.Log(line); };
            InstallState st = InstallState.Load(lay);
            if (File.Exists(lay.StateFile)) { win.CbStartup.Checked = st.StartupShortcut; win.CbMenu.Checked = st.StartMenuShortcut; }
            if (o.StartAtSignIn) win.CbStartup.Checked = true;

            win.BtnInstall.Click += delegate { StartWork(false); };
            win.BtnCancel.Click += delegate { cancel.Request(); win.Status("Stopping..."); };
            win.BtnOpen.Click += delegate { OpenPlatform(); };
            win.BtnHide.Click += delegate { HideToTray(); };
            win.CbStartup.Click += delegate { ApplyShortcutsNow(); };
            win.CbMenu.Click += delegate { ApplyShortcutsNow(); };
            win.FormClosing += OnFormClosing;

            BuildTray();
            if (smoke) return;
            tray.Visible = true;
            SetupWindow w = win;
            Thread t = new Thread(Begin);
            t.IsBackground = true;
            t.Name = "setup-begin";
            t.Start();
            if (!o.Background) w.Show();
        }

        sealed class NullReport : IReport
        {
            public void Row(StepRow row) { }
            public void Log(string line) { }
            public void Status(string text) { }
        }

        public SetupWindow Window { get { return win; } }
        public Controller Ctl { get { return ctl; } }

        // ── the first moments ───────────────────────────────────────────────

        public void Begin()
        {
            CheckResult cr = ctl.Check();
            if (quitting) return;
            if (cr.CannotContinue)
            {
                OnUi(delegate
                {
                    win.Headline.Text = "I cannot set up the runner yet";
                    win.Status(cr.Problem);
                    win.StatusLine.ForeColor = SetupWindow.Bad;
                    win.BtnInstall.Visible = false;
                    win.BtnHide.Text = "Close";
                    win.BtnHide.Visible = true;
                    ShowWindow();
                });
                return;
            }
            if (!cr.NeedsDownload && !smoke)
            {
                OnUi(delegate { win.Status("Everything is already here. Starting the runner..."); });
                StartWork(true);
                return;
            }
            OnUi(delegate
            {
                win.BtnInstall.Enabled = true;
                win.Status(cr.NeedsDownload ? "Some things are missing. Choose Install and start, and I will download only those." : "Everything is here.");
                if (!smoke) ShowWindow();
            });
        }

        void StartWork(bool automatic)
        {
            if (working) return;
            working = true;
            bool startup = false, menuLink = false;
            OnUi(delegate
            {
                startup = win.CbStartup.Checked; menuLink = win.CbMenu.Checked;
                win.BtnInstall.Enabled = false;
                win.BtnCancel.Visible = true;
                win.Headline.Text = "Setting up the " + Product.Name;
                win.StatusLine.ForeColor = SetupWindow.Ink;
            });
            Thread t = new Thread(delegate()
            {
                string problem = ctl.Install();
                if (problem == null)
                {
                    try { ctl.ApplyShortcuts(startup, menuLink); }
                    catch (Exception e) { log.Line("Could not add the shortcut: " + e.Message); }
                }
                OnUi(delegate
                {
                    working = false;
                    win.BtnCancel.Visible = false;
                    win.Bar.Visible = false;
                    if (problem != null)
                    {
                        win.Headline.Text = "The runner is not set up yet";
                        win.Status(problem);
                        win.StatusLine.ForeColor = SetupWindow.Bad;
                        win.BtnInstall.Text = "Try again";
                        win.BtnInstall.Enabled = true;
                        win.BtnHide.Visible = false;
                        ShowWindow();
                        return;
                    }
                    BeginRunner();
                });
            });
            t.IsBackground = true;
            t.Start();
        }

        void BeginRunner()
        {
            if (o.NoStart) { win.Headline.Text = "The runner is installed"; win.Status("It is not started (--no-start)."); win.BtnHide.Visible = true; return; }
            host = new RunnerHost(lay, ctl.Node.Path, ctl.PlatformUrl, ctl.RunnerName, log);
            host.Changed += delegate(RunnerStatus s) { OnUi(delegate { OnRunnerStatus(s); }); };
            host.Start();
            win.BtnOpen.Visible = true;
            win.BtnHide.Visible = true;
            win.BtnInstall.Visible = false;
        }

        // ── the runner's state, shown in the window and the tray ────────────

        void OnRunnerStatus(RunnerStatus s)
        {
            if (quitting) return;
            miStatus.Text = s.Text;
            tray.Text = Tip(s.Text);
            tray.Icon = IconFor(s.Phase);
            win.Status(s.Text);
            bool running = host != null && host.Running;
            miToggle.Text = running ? "Stop the runner" : "Start the runner";
            switch (s.Phase)
            {
                case RunnerPhase.Connected:
                    win.Headline.Text = "The runner is running";
                    win.Sub.Text = "You can close this window. The runner keeps working in the background; its icon is in the notification area next to the clock.";
                    win.StatusLine.ForeColor = SetupWindow.Teal;
                    if (!connectedOnce)
                    {
                        connectedOnce = true;
                        if (win.Visible && !o.Background) { /* the person is looking: leave the window open for them to close */ }
                        else tray.ShowBalloonTip(4000, Product.Name, s.Text, ToolTipIcon.Info);
                    }
                    break;
                case RunnerPhase.AccessRemoved:
                    win.Headline.Text = "This runner's access was removed";
                    win.StatusLine.ForeColor = SetupWindow.Bad;
                    tray.ShowBalloonTip(8000, Product.Name, "Access removed. Download a new runner from the platform.", ToolTipIcon.Warning);
                    ShowWindow();
                    break;
                case RunnerPhase.NeedsAttention:
                    win.Headline.Text = "The runner needs attention";
                    win.StatusLine.ForeColor = SetupWindow.Bad;
                    tray.ShowBalloonTip(8000, Product.Name, s.Text, ToolTipIcon.Warning);
                    ShowWindow();
                    break;
                case RunnerPhase.NotConnected:
                    win.StatusLine.ForeColor = SetupWindow.Warn;
                    break;
                default:
                    win.StatusLine.ForeColor = SetupWindow.Ink;
                    break;
            }
        }

        static string Tip(string s) { string t = Product.Name + ": " + s; return t.Length > 63 ? t.Substring(0, 60) + "..." : t; }

        Icon IconFor(RunnerPhase p)
        {
            Icon i;
            if (icons.TryGetValue(p, out i)) return i;
            Color dot;
            switch (p)
            {
                case RunnerPhase.Connected: dot = Color.FromArgb(0x2e, 0xa0, 0x5b); break;
                case RunnerPhase.AccessRemoved:
                case RunnerPhase.NeedsAttention: dot = Color.FromArgb(0xc0, 0x39, 0x2b); break;
                case RunnerPhase.Stopped:
                case RunnerPhase.NotStarted: dot = Color.FromArgb(0x8a, 0x8f, 0x98); break;
                default: dot = Color.FromArgb(0xd9, 0x9a, 0x1a); break;
            }
            Icon baseIcon = win.Icon ?? SystemIcons.Application;
            using (Bitmap bmp = new Bitmap(32, 32))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.DrawIcon(baseIcon, new Rectangle(0, 0, 32, 32));
                    using (SolidBrush white = new SolidBrush(Color.White)) g.FillEllipse(white, 15, 15, 17, 17);
                    using (SolidBrush b = new SolidBrush(dot)) g.FillEllipse(b, 17, 17, 13, 13);
                }
                i = Icon.FromHandle(bmp.GetHicon());
            }
            icons[p] = i;
            return i;
        }

        // ── tray ────────────────────────────────────────────────────────────

        void BuildTray()
        {
            miStatus.Enabled = false;
            menu.Items.Add(miStatus);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miOpen);
            menu.Items.Add(miShow);
            menu.Items.Add(miLog);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miToggle);
            menu.Items.Add(miRemove);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miQuit);
            tray.ContextMenuStrip = menu;
            tray.Text = Tip("Starting");
            tray.Icon = IconFor(RunnerPhase.Starting);
            tray.DoubleClick += delegate { ShowWindow(); };
            miOpen.Click += delegate { OpenPlatform(); };
            miShow.Click += delegate { ShowWindow(); };
            miLog.Click += delegate { ShowLog(); };
            miToggle.Click += delegate { ToggleRunner(); };
            miRemove.Click += delegate { RemoveEverything(); };
            miQuit.Click += delegate { Quit(0); };
        }

        void ToggleRunner()
        {
            if (host != null && host.Running)
            {
                miToggle.Enabled = false;
                Thread t = new Thread(delegate()
                {
                    host.Stop();
                    OnUi(delegate
                    {
                        miToggle.Enabled = true;
                        miToggle.Text = "Start the runner";
                        OnRunnerStatus(host.Status.Phase == RunnerPhase.AccessRemoved ? host.Status : StoppedStatus());
                    });
                });
                t.IsBackground = true;
                t.Start();
            }
            else if (ctl != null && ctl.Node != null)
            {
                host = new RunnerHost(lay, ctl.Node.Path, ctl.PlatformUrl, ctl.RunnerName, log);
                host.Changed += delegate(RunnerStatus s) { OnUi(delegate { OnRunnerStatus(s); }); };
                host.Start();
            }
        }

        static RunnerStatus StoppedStatus() { RunnerStatus s = new RunnerStatus(); s.Phase = RunnerPhase.Stopped; s.Text = "The runner is stopped"; return s; }

        public void ShowWindow()
        {
            if (win.IsDisposed) return;
            if (!win.Visible) win.Show();
            if (win.WindowState == FormWindowState.Minimized) win.WindowState = FormWindowState.Normal;
            win.Activate();
        }

        void HideToTray()
        {
            win.Hide();
            if (!toldAboutTray)
            {
                toldAboutTray = true;
                tray.ShowBalloonTip(3000, Product.Name, "The runner keeps working in the background. Right-click this icon for the menu.", ToolTipIcon.Info);
            }
        }

        void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (quitting || e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.ApplicationExitCall) return;
            // The close button hides the window; the runner carries on. "Close this program" in the tray menu really ends it.
            if (host != null || working) { e.Cancel = true; HideToTray(); return; }
            quitting = true;
            ExitThread();
        }

        void OpenPlatform()
        {
            Uri u;
            if (Uri.TryCreate(ctl.PlatformUrl, UriKind.Absolute, out u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps))
            {
                try { Process.Start(u.AbsoluteUri); } catch (Exception e) { log.Line("Could not open the browser: " + e.Message); }
            }
        }

        void ShowLog()
        {
            win.SetDetails(true);
            ShowWindow();
            string f = File.Exists(lay.RunnerLog) ? lay.RunnerLog : lay.SetupLog;
            if (File.Exists(f)) { try { Process.Start("notepad.exe", Util.Quote(f)); } catch (Exception) { } }
        }

        void ApplyShortcutsNow()
        {
            if (working || !File.Exists(lay.StateFile)) return;
            bool s = win.CbStartup.Checked, m = win.CbMenu.Checked;
            try { ctl.ApplyShortcuts(s, m); }
            catch (Exception e) { log.Line("Could not change the shortcut: " + e.Message); win.Status("Could not change the shortcut: " + e.Message); }
        }

        void RemoveEverything()
        {
            DialogResult r = MessageBox.Show(win,
                "Remove the " + Product.Name + " from this computer?\r\n\r\nThis stops the runner and deletes " + lay.Root + " and the shortcuts this program made. A Node.js that was already installed and the shared browser cache stay.",
                Product.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (r != DialogResult.Yes) return;
            quitting = true;
            cancel.Request();
            Thread t = new Thread(delegate()
            {
                if (host != null) host.Stop();
                RunnerHost.ReapRecorded(lay, log);
                bool scheduled;
                List<string> lines = ctl.Uninstall(out scheduled);
                OnUi(delegate
                {
                    tray.Visible = false;
                    MessageBox.Show(string.Join("\r\n", lines.ToArray()), Product.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    ExitThread();
                });
            });
            t.IsBackground = true;
            t.Start();
        }

        public void Quit(int code)
        {
            if (quitting) return;
            quitting = true;
            cancel.Request();
            Thread t = new Thread(delegate()
            {
                if (host != null) host.Stop();
                OnUi(delegate { tray.Visible = false; ExitThread(); });
            });
            t.IsBackground = true;
            t.Start();
        }

        /// <summary>Runs on the window's thread, whichever thread asks.</summary>
        void OnUi(Action a)
        {
            if (win.IsDisposed) return;
            try
            {
                if (win.InvokeRequired) win.BeginInvoke(a);
                else a();
            }
            catch (Exception) { }
        }

        protected override void ExitThreadCore()
        {
            tray.Visible = false;
            tray.Dispose();
            base.ExitThreadCore();
        }

        public bool RunnerStopped { get { return host == null || !host.Running; } }
        public RunnerHost Host { get { return host; } }
    }

    static class UiSmoke
    {
        /// <summary>Builds the window and the tray menu without showing them, runs the checks, optionally saves a picture of the window, and ends.</summary>
        public static int Run(Options o, Layout lay, FileLog log)
        {
            UiApp app = new UiApp(o, lay, log, true);
            SetupWindow w = app.Window;
            // The checks run on this thread so the picture shows their result.
            CheckResult cr = app.Ctl.Check();
            for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
            Console.WriteLine("window: " + w.Text + "; rows: " + w.List.Items.Count + "; handle: " + (w.IsHandleCreated ? "yes" : "no"));
            for (int i = 0; i < w.List.Items.Count; i++) Console.WriteLine("row " + w.List.Items[i].Text + " | " + w.List.Items[i].SubItems[1].Text + " | " + w.List.Items[i].SubItems[2].Text);
            if (!string.IsNullOrEmpty(o.Screenshot))
            {
                w.Status(cr.NeedsDownload ? "Some things are missing. Choose Install and start, and I will download only those." : "Everything is here.");
                w.BtnInstall.Enabled = true;
                // A window that was never shown paints nothing, so show it far off screen for the picture (no taskbar button, nobody sees it).
                w.StartPosition = FormStartPosition.Manual;
                w.Location = new Point(-32000, -32000);
                w.ShowInTaskbar = false;
                w.Show();
                for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
                using (Bitmap bmp = new Bitmap(w.Width, w.Height))
                {
                    w.DrawToBitmap(bmp, new Rectangle(0, 0, bmp.Width, bmp.Height));
                    bmp.Save(o.Screenshot, System.Drawing.Imaging.ImageFormat.Png);
                }
                Console.WriteLine("screenshot: " + o.Screenshot);
            }
            w.Dispose();
            app.Dispose();
            return 0;
        }
    }
}
