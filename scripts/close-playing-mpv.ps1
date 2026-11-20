$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$inputJson = [Console]::In.ReadToEnd()
if (!(Get-Process -Name mpv -ErrorAction SilentlyContinue)) { Write-Output 0; exit 0 }
[string[]]$paths = @((ConvertFrom-Json -InputObject $inputJson) | Where-Object {
  $_ -is [string] -and [IO.Path]::IsPathRooted($_) -and [IO.File]::Exists($_)
})
if (!$paths.Length) { Write-Output 0; exit 0 }

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class AniBTMpvHandles
{
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessId
    {
        public int Pid;
        public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessInfo
    {
        public ProcessId Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
        public uint AppType, Status, SessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint handle, uint flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint handle, uint files, string[] names,
        uint processCount, IntPtr processes, uint serviceCount, IntPtr services);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(uint handle, out uint needed, ref uint count,
        [In, Out] ProcessInfo[] apps, ref uint rebootReasons);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint handle);

    private static void Check(int result)
    {
        if (result != 0) throw new Win32Exception(result);
    }

    public static int ClosePlayers(string[] files)
    {
        uint handle;
        Check(RmStartSession(out handle, 0, new StringBuilder(33)));
        try
        {
            Check(RmRegisterResources(handle, (uint)files.Length, files, 0, IntPtr.Zero, 0, IntPtr.Zero));
            uint needed, count = 0, reasons = 0;
            int result = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (result == 0) return 0;
            if (result != 234) Check(result);
            ProcessInfo[] apps = null;
            for (int attempt = 0; attempt < 3 && result == 234; attempt++)
            {
                count = needed;
                apps = new ProcessInfo[count];
                result = RmGetList(handle, out needed, ref count, apps, ref reasons);
            }
            Check(result);
            int closed = 0;
            for (int i = 0; i < count; i++)
            {
                ProcessId identity = apps[i].Process;
                try
                {
                    using (Process player = Process.GetProcessById(identity.Pid))
                    {
                        long start = ((long)identity.StartTime.dwHighDateTime << 32) | (uint)identity.StartTime.dwLowDateTime;
                        if (!player.ProcessName.Equals("mpv", StringComparison.OrdinalIgnoreCase) ||
                            player.StartTime.ToUniversalTime().ToFileTimeUtc() != start) continue;
                        if (!player.CloseMainWindow() && !player.HasExited)
                            throw new Exception("The matching mpv process has no closable window.");
                        if (!player.WaitForExit(6500)) throw new Exception("The matching mpv process did not exit.");
                        closed++;
                    }
                }
                catch (ArgumentException) { }
            }
            return closed;
        }
        finally { RmEndSession(handle); }
    }
}
"@
[AniBTMpvHandles]::ClosePlayers($paths)
