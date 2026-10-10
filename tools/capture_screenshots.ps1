# Starts each built example, lets it render for a few seconds, and saves a screenshot of its window
# for the README, as docs/screenshots/<example>.jpg (scaled down to -Width pixels).
#
#   pwsh -File tools/capture_screenshots.ps1 [-Examples basic_triangle,compute_nbody] [-Api dx12] [-Seconds 6]
#       [-RunArgs "-noui"] [-HoldKeys "S:3000,NumPad2:500"]
#
# With no -Examples, captures every examples/*.ts that has a built executable in build/bin (headless
# has no window and is skipped). An example that exits before -Seconds is retried on the other API.
# The capture is a desktop capture of the window's client area: leave the desktop alone while it
# runs, as an example only renders while its window has focus and is on top.
param(
    [string]$Examples = "",
    [string]$Api = "dx12",
    [int]$Seconds = 6,
    [int]$Width = 640,
    # Arguments for every example run, after the per-example ones (for trying out views).
    [string]$RunArgs = "",
    # Keys to hold in the example's window before the capture, as <key>:<milliseconds> (for
    # trying out views); e.g. "S:4000". A key is a letter, a digit or a System.Windows.Forms.Keys name.
    [string]$HoldKeys = ""
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CaptureWin32 {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
[CaptureWin32]::SetProcessDPIAware() | Out-Null

$exampleList = @($Examples -split "[,\s]+" | Where-Object { $_ })

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "build/bin"
$outDir = Join-Path $root "docs/screenshots"
New-Item -ItemType Directory -Force $outDir | Out-Null

if ($exampleList.Count -eq 0) {
    $exampleList = @(Get-ChildItem (Join-Path $root "examples/*.ts") |
        ForEach-Object { $_.BaseName } |
        Where-Object { $_ -ne "headless" -and (Test-Path (Join-Path $bin "$_.exe")) })
}

# Arguments some examples need on every run, or that give them a better view.
$extraArgs = @{
    "video_texture" = @("-mute")
    "graphics_pipeline_library" = @("-pipelines", "16", "-seed", "7")
    "ray_tracing_invocation_reorder" = @("-noui")
}

# Keys held in an example's window before its capture (see -HoldKeys), to move its camera.
$viewKeys = @{
    # From inside the scanned room to above it: pitch, back away, pitch back up, step left.
    "render_octomap" = "NumPad2:1500,S:12000,NumPad2:300,A:1500"
}

# Holds each <key>:<milliseconds> of $spec in turn in the foreground window.
function HoldKeys([string]$spec) {
    Add-Type -AssemblyName System.Windows.Forms
    foreach ($item in @($spec -split "[,\s]+" | Where-Object { $_ })) {
        $name, $ms = $item -split ":"
        $vk = [byte][System.Windows.Forms.Keys]$name
        [CaptureWin32]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds ([int]$ms)
        [CaptureWin32]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
    }
}

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$jpegParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$jpegParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]85)

# Runs one example on one API; returns $true if it saved a screenshot.
function Capture([string]$example, [string]$api) {
    $exe = Join-Path $bin "$example.exe"
    $arguments = @("-$api") + $extraArgs[$example] + @($RunArgs -split "\s+" | Where-Object { $_ })
    $p = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $bin -PassThru -WindowStyle Normal
    try {
        if ($p.WaitForExit($Seconds * 1000)) {
            return $false
        }
        $p.Refresh()
        $hwnd = $p.MainWindowHandle
        if ($hwnd -eq [IntPtr]::Zero) {
            return $false
        }
        [CaptureWin32]::SetForegroundWindow($hwnd) | Out-Null
        Start-Sleep -Milliseconds 500
        HoldKeys ((@($viewKeys[$example]) + $HoldKeys | Where-Object { $_ }) -join ",")
        Start-Sleep -Milliseconds 1000
        $rect = New-Object CaptureWin32+RECT
        [CaptureWin32]::GetClientRect($hwnd, [ref]$rect) | Out-Null
        $origin = New-Object CaptureWin32+POINT
        [CaptureWin32]::ClientToScreen($hwnd, [ref]$origin) | Out-Null
        $w = $rect.Right - $rect.Left
        $h = $rect.Bottom - $rect.Top
        if ($w -le 0 -or $h -le 0) {
            return $false
        }
        $full = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($full)
        $g.CopyFromScreen($origin.X, $origin.Y, 0, 0, $full.Size)
        $g.Dispose()

        $sw = [Math]::Min($Width, $w)
        $sh = [int][Math]::Round($h * $sw / $w)
        $small = New-Object System.Drawing.Bitmap $sw, $sh
        $g = [System.Drawing.Graphics]::FromImage($small)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($full, 0, 0, $sw, $sh)
        $g.Dispose()
        $small.Save((Join-Path $outDir "$example.jpg"), $jpegCodec, $jpegParams)
        $small.Dispose()
        $full.Dispose()
        return $true
    } finally {
        if (-not $p.HasExited) {
            Stop-Process -Id $p.Id -Force
            $p.WaitForExit()
        }
    }
}

$otherApi = if ($Api -eq "dx12") { "vk" } else { "dx12" }
$failures = @()
foreach ($example in $exampleList) {
    if (-not (Test-Path (Join-Path $bin "$example.exe"))) {
        $failures += "${example}: not built"
        continue
    }
    $used = $Api
    $ok = Capture $example $Api
    if (-not $ok) {
        $used = $otherApi
        $ok = Capture $example $otherApi
    }
    if ($ok) {
        Write-Host "ok   $example ($used)"
    } else {
        $failures += $example
        Write-Host "FAIL $example"
    }
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "capture_screenshots: $($failures.Count) failure(s)"
    $failures | ForEach-Object { Write-Host "  $_" }
    exit 1
}
Write-Host "capture_screenshots: all captured"
