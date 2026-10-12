using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// WindowEmbed.exe
// Small Win32 helper used to embed the WhatTheDub (Unity) game window as a
// child of the Electron picker window so it can be streamed as a single window.
//
// Usage:
//   WindowEmbed.exe find    <parentHwnd>
//   WindowEmbed.exe raise   <parentHwnd> <x> <y> <w> <h>
//   WindowEmbed.exe client  <parentHwnd>
//   WindowEmbed.exe rect    <parentHwnd>
//   WindowEmbed.exe focus   <parentHwnd>
//   WindowEmbed.exe detach  <parentHwnd>
//
// All commands print a single JSON line to stdout.
class Program
{
    const string UnityClass = "UnityWndClass";

    const long WS_CHILD = 0x40000000L;
    const long WS_POPUP = unchecked((long)0x80000000L);
    const long WS_CAPTION = 0x00C00000L;
    const long WS_THICKFRAME = 0x00040000L;

    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_ASYNCWINDOWPOS = 0x4000;

    const int GWL_STYLE = -16;

    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumChildProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetParent(IntPtr child, IntPtr newParent);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern int MapWindowPoints(IntPtr from, IntPtr to, ref RECT points, uint count);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetWindowLong32(IntPtr hWnd, int index, int value);

    delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    static void Main(string[] args)
    {
        try
        {
            if (args.Length < 2)
            {
                Console.WriteLine("{\"found\":false,\"error\":\"usage\"}");
                return;
            }

            string cmd = args[0];
            long parentValue;
            if (!long.TryParse(args[1], out parentValue))
            {
                Console.WriteLine("{\"found\":false,\"error\":\"bad-hwnd\"}");
                return;
            }

            IntPtr parent = new IntPtr(parentValue);
            if (!IsWindow(parent))
            {
                Console.WriteLine("{\"found\":false,\"error\":\"invalid-parent\"}");
                return;
            }

            IntPtr child = FindGameChild(parent);
            if (child == IntPtr.Zero)
            {
                Console.WriteLine("{\"found\":false}");
                return;
            }

            uint pid;
            GetWindowThreadProcessId(child, out pid);
            long hwnd = child.ToInt64();

            switch (cmd)
            {
                case "find":
                    Console.WriteLine("{\"found\":true,\"hwnd\":" + hwnd + ",\"pid\":" + pid +
                        ",\"visible\":" + (IsWindowVisible(child) ? "true" : "false") +
                        ",\"style\":\"" + GetStyle(child).ToString("X") + "\"}");
                    return;

                case "raise":
                {
                    int x = 0, y = 0, w = 0, h = 0;
                    if (args.Length >= 6)
                    {
                        int.TryParse(args[2], out x);
                        int.TryParse(args[3], out y);
                        int.TryParse(args[4], out w);
                        int.TryParse(args[5], out h);
                    }

                    if (w <= 0 || h <= 0)
                    {
                        RECT cr;
                        if (GetClientRect(parent, out cr))
                        {
                            w = cr.Right - cr.Left;
                            h = cr.Bottom - cr.Top;
                        }
                    }

                    long style = GetStyle(child);
                    style |= WS_CHILD;
                    style &= ~WS_POPUP;
                    style &= ~WS_CAPTION;
                    style &= ~WS_THICKFRAME;
                    SetStyle(child, style);

                    uint flags = SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS;
                    if (w > 0 && h > 0)
                    {
                        SetWindowPos(child, IntPtr.Zero, x, y, w, h, flags);
                    }
                    else
                    {
                        SetWindowPos(child, IntPtr.Zero, 0, 0, 0, 0, flags | SWP_NOMOVE | SWP_NOSIZE);
                    }

                    Console.WriteLine("{\"found\":true,\"hwnd\":" + hwnd + ",\"pid\":" + pid + "}");
                    return;
                }

                case "client":
                {
                    RECT cr;
                    if (!GetClientRect(parent, out cr))
                    {
                        Console.WriteLine("{\"found\":false,\"error\":\"client-rect-failed\"}");
                        return;
                    }
                    Console.WriteLine("{\"found\":true,\"width\":" + (cr.Right - cr.Left) + ",\"height\":" + (cr.Bottom - cr.Top) + "}");
                    return;
                }

                case "rect":
                {
                    RECT pr, pcr, cwr;
                    GetWindowRect(parent, out pr);
                    GetClientRect(parent, out pcr);
                    GetWindowRect(child, out cwr);
                    Console.WriteLine(
                        "{\"found\":true," +
                        "\"parentWindow\":{\"l\":" + pr.Left + ",\"t\":" + pr.Top + ",\"r\":" + pr.Right + ",\"b\":" + pr.Bottom + "}," +
                        "\"parentClient\":{\"w\":" + (pcr.Right - pcr.Left) + ",\"h\":" + (pcr.Bottom - pcr.Top) + "}," +
                        "\"childWindow\":{\"l\":" + cwr.Left + ",\"t\":" + cwr.Top + ",\"r\":" + cwr.Right + ",\"b\":" + cwr.Bottom + "}," +
                        "\"childClient\":{\"w\":" + (cwr.Right - cwr.Left) + ",\"h\":" + (cwr.Bottom - cwr.Top) + "}" +
                        "}");
                    return;
                }

                case "focus":
                    SetForegroundWindow(child);
                    Console.WriteLine("{\"found\":true,\"focused\":true}");
                    return;

                case "detach":
                {
                    SetParent(child, IntPtr.Zero);
                    long style = GetStyle(child);
                    style &= ~WS_CHILD;
                    style |= WS_POPUP;
                    SetStyle(child, style);
                    ShowWindow(child, 5); // SW_SHOW
                    Console.WriteLine("{\"found\":true,\"detached\":true}");
                    return;
                }

                default:
                    Console.WriteLine("{\"found\":false,\"error\":\"unknown-command\"}");
                    return;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("{\"found\":false,\"error\":\"" + ex.Message.Replace("\"", "'") + "\"}");
        }
    }

    static IntPtr FindGameChild(IntPtr parent)
    {
        // First pass: match by Unity window class.
        IntPtr byClass = IntPtr.Zero;
        EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam)
        {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (string.Equals(sb.ToString(), UnityClass, StringComparison.Ordinal))
            {
                byClass = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);

        if (byClass != IntPtr.Zero) return byClass;

        // Fallback: match by owning process name.
        IntPtr byProc = IntPtr.Zero;
        EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (IsWhatTheDub(pid))
            {
                byProc = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);

        return byProc;
    }

    static bool IsWhatTheDub(uint pid)
    {
        try
        {
            string name = Process.GetProcessById((int)pid).ProcessName;
            return name != null && name.StartsWith("WhatTheDub", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    static long GetStyle(IntPtr hWnd)
    {
        if (IntPtr.Size == 8) return GetWindowLongPtr64(hWnd, GWL_STYLE).ToInt64();
        return GetWindowLong32(hWnd, GWL_STYLE);
    }

    static void SetStyle(IntPtr hWnd, long style)
    {
        if (IntPtr.Size == 8) SetWindowLongPtr64(hWnd, GWL_STYLE, new IntPtr(style));
        else SetWindowLong32(hWnd, GWL_STYLE, (int)style);
    }
}
