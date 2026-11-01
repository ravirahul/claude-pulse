// Claude Pulse tray host: supervises the Node server, owns the tray icon, and opens the
// dashboard as a compact Edge app window. Build with build.ps1 (uses the csc.exe that ships with Windows).
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Claude Pulse")]
[assembly: System.Reflection.AssemblyProduct("Claude Pulse")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

static class Pulse
{
    const int Port = 47821;
    static readonly string Url = "http://127.0.0.1:" + Port + "/";
    static readonly string Dir = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudePulse");
    static readonly string StartupLnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Claude Pulse.lnk");

    static NotifyIcon tray;
    static Process server;
    static bool quitting;
    static int restarts;
    static DateTime serverStart;
    static IntPtr job;
    static SynchronizationContext ui;

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--make-icon") { File.WriteAllBytes(args[1], MakeIco()); return; }
        if (args.Length == 3 && args[0] == "--make-png") { using (var b = DrawIcon(int.Parse(args[2]))) b.Save(args[1], System.Drawing.Imaging.ImageFormat.Png); return; }

        bool created;
        var mutex = new Mutex(true, "ClaudePulse.Tray.v1", out created);
        var showEvt = new EventWaitHandle(false, EventResetMode.AutoReset, "ClaudePulse.Show.v1");
        if (!created) { showEvt.Set(); return; } // already running: ask it to show the window

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Directory.CreateDirectory(DataDir);
        job = CreateKillOnCloseJob();

        var host = new HotkeyWindow();
        ui = new WindowsFormsSynchronizationContext();
        SynchronizationContext.SetSynchronizationContext(ui);

        tray = new NotifyIcon { Icon = MakeIcon(16), Text = "Claude Pulse", Visible = true };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Pulse", null, (s, e) => ToggleWindow(true));
        menu.Items.Add("New Claude Code session…", null, (s, e) => OpenNew());
        resumeMenu = new ToolStripMenuItem("Resume");
        resumeMenu.DropDownItems.Add(new ToolStripMenuItem("Loading…") { Enabled = false });
        menu.Items.Add(resumeMenu);
        menu.Opening += (s, e) => { BuildResume(); Poll(); };
        menu.Items.Add(new ToolStripSeparator());
        var startup = new ToolStripMenuItem("Start with Windows") { Checked = File.Exists(StartupLnk) };
        startup.Click += (s, e) => { SetStartup(!File.Exists(StartupLnk)); startup.Checked = File.Exists(StartupLnk); };
        menu.Items.Add(startup);
        menu.Items.Add("Restart server", null, (s, e) => { KillServer(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (s, e) => Quit());
        ((ToolStripMenuItem)menu.Items[0]).Font = new Font(menu.Font, FontStyle.Bold);
        tray.ContextMenuStrip = menu;
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ToggleWindow(false); };
        tray.BalloonTipClicked += (s, e) => ToggleWindow(true);

        StartServer();

        // second instance / taskbar pin -> show
        ThreadPool.RegisterWaitForSingleObject(showEvt, (st, to) => ui.Post(_ => ToggleWindow(true), null), null, -1, false);

        var poll = new System.Windows.Forms.Timer { Interval = 60000 };
        poll.Tick += (s, e) => Poll();
        poll.Start();
        var first = new System.Windows.Forms.Timer { Interval = 5000 };
        first.Tick += (s, e) => { first.Stop(); Poll(); };
        first.Start();

        if (Array.IndexOf(args, "--silent") < 0) ToggleWindow(true);
        Application.Run();
        GC.KeepAlive(mutex);
        GC.KeepAlive(host);
    }

    // ---------- server supervision ----------
    static string FindNode()
    {
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string p = Path.Combine(pf, "nodejs", "node.exe");
        if (File.Exists(p)) return p;
        foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try { var c = Path.Combine(d.Trim(), "node.exe"); if (File.Exists(c)) return c; } catch { }
        }
        return "node.exe";
    }

    static void StartServer()
    {
        if (quitting) return;
        try
        {
            var psi = new ProcessStartInfo(FindNode(), "--max-old-space-size=192 \"" + Path.Combine(Dir, "server.js") + "\"")
            {
                WorkingDirectory = Dir, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
            };
            server = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var log = Path.Combine(DataDir, "server.log");
            server.OutputDataReceived += (s, e) => Log(log, e.Data);
            server.ErrorDataReceived += (s, e) => Log(log, e.Data);
            server.Exited += (s, e) => ui.Post(_ => OnServerExit(), null);
            server.Start();
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
            if (job != IntPtr.Zero) AssignProcessToJobObject(job, server.Handle);
            serverStart = DateTime.Now;
        }
        catch (Exception ex)
        {
            Log(Path.Combine(DataDir, "server.log"), "start failed: " + ex.Message);
            ScheduleRestart();
        }
    }

    static void OnServerExit()
    {
        if (quitting) return;
        if ((DateTime.Now - serverStart).TotalSeconds > 60) restarts = 0;
        ScheduleRestart();
    }

    static void ScheduleRestart()
    {
        restarts++;
        int delay = Math.Min(30000, 1000 * (1 << Math.Min(restarts, 5))); // 2s,4s,8s,16s,30s
        var t = new System.Windows.Forms.Timer { Interval = delay };
        t.Tick += (s, e) => { t.Stop(); t.Dispose(); StartServer(); };
        t.Start();
    }

    static void KillServer()
    {
        try { if (server != null && !server.HasExited) server.Kill(); } catch { }
        restarts = 0;
    }

    static readonly object logLock = new object();
    static void Log(string file, string line)
    {
        if (line == null) return;
        lock (logLock)
        {
            try
            {
                var fi = new FileInfo(file);
                if (fi.Exists && fi.Length > 256 * 1024) fi.Delete();
                File.AppendAllText(file, DateTime.Now.ToString("s") + " " + line + Environment.NewLine);
            }
            catch { }
        }
    }

    static void Quit()
    {
        quitting = true;
        tray.Visible = false;
        try { if (server != null && !server.HasExited) server.Kill(); } catch { }
        Application.Exit();
    }

    // ---------- window ----------
    static void ToggleWindow(bool forceShow)
    {
        IntPtr h = FindPulseWindow();
        if (h != IntPtr.Zero)
        {
            if (!forceShow && GetForegroundWindow() == h && !IsIconic(h)) { ShowWindow(h, 6 /*SW_MINIMIZE*/); return; }
            if (IsIconic(h)) ShowWindow(h, 9 /*SW_RESTORE*/);
            SetForegroundWindow(h);
            return;
        }
        LaunchWindow("");
    }

    static void OpenNew()
    {
        IntPtr h = FindPulseWindow();
        if (h != IntPtr.Zero)
        {
            // the page picks this flag up on its next fetch (focus triggers one)
            try { using (var wc = new System.Net.WebClient()) wc.DownloadString(Url + "api/signal-new"); } catch { }
            if (IsIconic(h)) ShowWindow(h, 9);
            SetForegroundWindow(h);
            return;
        }
        LaunchWindow("#new");
    }

    static void LaunchWindow(string hash)
    {
        var wa = Screen.PrimaryScreen.WorkingArea;
        int w = 460, hgt = Math.Min(820, wa.Height - 24);
        int x = wa.Right - w - 12, y = wa.Bottom - hgt - 12;
        string edge = FindEdge();
        string profile = Path.Combine(DataDir, "edge");
        string a = "--app=" + Url + hash + " --user-data-dir=\"" + profile + "\" --window-size=" + w + "," + hgt +
                   " --window-position=" + x + "," + y + " --no-first-run --no-default-browser-check --disable-extensions" +
                   " --disable-sync --disable-background-mode --disable-gpu --in-process-gpu --renderer-process-limit=1" +
                   " --disable-features=msEdgeStartupBoost,msImplicitSignin,Translate,SpareRendererForSitePerProcess,msEntityExtraction,OptimizationHints";
        try
        {
            if (edge != null) Process.Start(new ProcessStartInfo(edge, a) { UseShellExecute = false });
            else Process.Start(Url + hash);
        }
        catch { try { Process.Start(Url + hash); } catch { } }
    }

    static string FindEdge()
    {
        foreach (var root in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) })
        {
            var p = Path.Combine(root, @"Microsoft\Edge\Application\msedge.exe");
            if (File.Exists(p)) return p;
        }
        return null;
    }

    static IntPtr FindPulseWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h) && !IsIconic(h)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.ToString() == "Claude Pulse") { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // ---------- tray data: tooltip, limit alerts, resume menu ----------
    static ToolStripMenuItem resumeMenu;
    static System.Collections.ArrayList recent;
    static long alertedFor, resetWatch;
    static int polling;

    static object Get(System.Collections.Generic.Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) ? v : null; }
    static string When(object ms)
    {
        if (ms == null) return null;
        var t = DateTimeOffset.FromUnixTimeMilliseconds(Convert.ToInt64(ms)).LocalDateTime;
        return (t.Date == DateTime.Today ? "" : t.ToString("ddd ")) + t.ToString("h:mm tt");
    }

    static void Poll()
    {
        if (Interlocked.Exchange(ref polling, 1) == 1) return;
        ThreadPool.QueueUserWorkItem(_ =>
        {
            System.Collections.Generic.Dictionary<string, object> d = null;
            try
            {
                using (var wc = new System.Net.WebClient { Encoding = Encoding.UTF8 })
                    d = new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(wc.DownloadString(Url + "api/tray"));
            }
            catch { }
            Interlocked.Exchange(ref polling, 0);
            if (d != null) ui.Post(__ => OnPoll(d), null);
        });
    }

    static void OnPoll(System.Collections.Generic.Dictionary<string, object> d)
    {
        recent = Get(d, "recent") as System.Collections.ArrayList;
        object fh = Get(d, "fh"), sd = Get(d, "sd"), fhReset = Get(d, "fhReset");
        string tip = "Claude Pulse";
        if (fh != null) tip += "\n5h " + fh + "%" + (fhReset != null ? " · resets " + When(fhReset) : "");
        if (sd != null) tip += "\nWeek " + sd + "%";
        tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;

        if (!(Get(d, "alerts") is bool && (bool)Get(d, "alerts"))) return;
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long reset = fhReset != null ? Convert.ToInt64(fhReset) : 0;
        if (fh != null && Convert.ToInt32(fh) >= 80 && reset > now && alertedFor != reset)
        {
            alertedFor = reset; resetWatch = reset;
            tray.ShowBalloonTip(8000, "5-hour limit at " + fh + "%", "Resets at " + When(reset) + ".", ToolTipIcon.Warning);
        }
        if (resetWatch > 0 && now >= resetWatch)
        {
            resetWatch = 0;
            tray.ShowBalloonTip(6000, "5-hour limit has reset", "You're back to full capacity.", ToolTipIcon.Info);
        }
    }

    static void BuildResume()
    {
        resumeMenu.DropDownItems.Clear();
        if (recent == null || recent.Count == 0) { resumeMenu.DropDownItems.Add(new ToolStripMenuItem("No recent sessions") { Enabled = false }); return; }
        foreach (System.Collections.Generic.Dictionary<string, object> s in recent)
        {
            string title = Convert.ToString(Get(s, "title")), proj = Convert.ToString(Get(s, "project"));
            if (title.Length > 48) title = title.Substring(0, 46) + "…";
            var sid = Convert.ToString(Get(s, "sid")); var cwd = Convert.ToString(Get(s, "cwd"));
            var it = new ToolStripMenuItem(title) { ShortcutKeyDisplayString = proj, ToolTipText = cwd };
            it.Click += (o, e) => Resume(sid, cwd);
            resumeMenu.DropDownItems.Add(it);
        }
    }

    static void Resume(string sid, string cwd)
    {
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try
            {
                string token = File.ReadAllText(Path.Combine(DataDir, "token")).Trim();
                var ser = new System.Web.Script.Serialization.JavaScriptSerializer();
                using (var wc = new System.Net.WebClient { Encoding = Encoding.UTF8 })
                {
                    wc.Headers["Content-Type"] = "application/json";
                    wc.Headers["X-Pulse-Token"] = token;
                    wc.UploadString(Url + "api/launch", ser.Serialize(new System.Collections.Generic.Dictionary<string, object> { { "resume", sid }, { "cwd", cwd } }));
                }
            }
            catch (Exception ex) { ui.Post(__ => tray.ShowBalloonTip(5000, "Could not resume", ex.Message, ToolTipIcon.Error), null); }
        });
    }

    // ---------- start with Windows ----------
    static void SetStartup(bool on)
    {
        try
        {
            if (!on) { if (File.Exists(StartupLnk)) File.Delete(StartupLnk); return; }
            var t = Type.GetTypeFromProgID("WScript.Shell");
            object sh = Activator.CreateInstance(t);
            object lnk = t.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, sh, new object[] { StartupLnk });
            var lt = lnk.GetType();
            string exe = Application.ExecutablePath;
            lt.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { exe });
            lt.InvokeMember("Arguments", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { "--silent" });
            lt.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { Dir });
            lt.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { exe + ",0" });
            lt.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, lnk, null);
        }
        catch (Exception ex) { MessageBox.Show("Could not update startup: " + ex.Message, "Claude Pulse"); }
    }

    // ---------- icon ----------
    static Bitmap DrawIcon(int size)
    {
        var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            float r = size * 0.24f, s = size - 1;
            using (var path = new GraphicsPath())
            {
                path.AddArc(0, 0, r * 2, r * 2, 180, 90);
                path.AddArc(s - r * 2, 0, r * 2, r * 2, 270, 90);
                path.AddArc(s - r * 2, s - r * 2, r * 2, r * 2, 0, 90);
                path.AddArc(0, s - r * 2, r * 2, r * 2, 90, 90);
                path.CloseFigure();
                using (var b = new SolidBrush(Color.FromArgb(224, 133, 102))) g.FillPath(b, path);
            }
            float k = size / 24f;
            var pts = new[] { new PointF(3 * k, 12.5f * k), new PointF(7 * k, 12.5f * k), new PointF(10 * k, 5.5f * k), new PointF(14 * k, 18.5f * k), new PointF(17 * k, 12.5f * k), new PointF(21 * k, 12.5f * k) };
            using (var pen = new Pen(Color.White, Math.Max(1.6f, 2.4f * k)) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round })
                g.DrawLines(pen, pts);
        }
        return bmp;
    }

    static Icon MakeIcon(int size)
    {
        size = Math.Max(size, SystemInformation.SmallIconSize.Width);
        using (var ms = new MemoryStream(MakeIco(new[] { size }))) return new Icon(ms, size, size);
    }

    // ICO file with PNG-compressed entries (Vista+)
    static byte[] MakeIco(int[] sizes = null)
    {
        sizes = sizes ?? new[] { 16, 20, 24, 32, 40, 48, 64, 256 };
        var pngs = new byte[sizes.Length][];
        for (int i = 0; i < sizes.Length; i++)
            using (var bmp = DrawIcon(sizes[i])) using (var m = new MemoryStream()) { bmp.Save(m, System.Drawing.Imaging.ImageFormat.Png); pngs[i] = m.ToArray(); }
        using (var o = new MemoryStream())
        using (var w = new BinaryWriter(o))
        {
            w.Write((short)0); w.Write((short)1); w.Write((short)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i])); w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
                w.Write((byte)0); w.Write((byte)0); w.Write((short)1); w.Write((short)32);
                w.Write(pngs[i].Length); w.Write(offset); offset += pngs[i].Length;
            }
            foreach (var p in pngs) w.Write(p);
            return o.ToArray();
        }
    }

    // ---------- global hotkey Ctrl+Alt+P ----------
    class HotkeyWindow : NativeWindow
    {
        public HotkeyWindow() { CreateHandle(new CreateParams()); RegisterHotKey(Handle, 1, 0x0001 | 0x0002 | 0x4000 /*ALT|CTRL|NOREPEAT*/, (uint)Keys.P); }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0312) ToggleWindow(false);
            base.WndProc(ref m);
        }
    }

    // ---------- job object: node dies with the tray ----------
    static IntPtr CreateKillOnCloseJob()
    {
        IntPtr h = CreateJobObject(IntPtr.Zero, null);
        if (h == IntPtr.Zero) return h;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        // KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK: node dies with the tray, but sessions node launches don't
        info.BasicLimitInformation.LimitFlags = 0x2000 | 0x1000;
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr p = Marshal.AllocHGlobal(len);
        Marshal.StructureToPtr(info, p, false);
        SetInformationJobObject(h, 9, p, (uint)len);
        Marshal.FreeHGlobal(p);
        return h;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
}
