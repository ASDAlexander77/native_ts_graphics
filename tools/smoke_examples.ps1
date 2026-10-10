# Starts built examples briefly on each graphics API with the debug layers and reports the ones
# that crash, exit with an error, or log errors (Donut's "ERROR:" lines, validation messages).
#
#   pwsh -File tools/smoke_examples.ps1 [-Examples basic_triangle,compute_nbody] [-Apis dx12,vk] [-Seconds 8]
#
# With no -Examples, runs every examples/*.ts that has a built executable in build/bin. An example
# still running after -Seconds passes (it is stopped then); one that exits sooner passes only with
# exit code 0. The output of each run is kept in build/smoke/<example>.<api>.{out,err}.txt.
# Examples start as normal windows: leave the desktop alone while it runs, as an example only
# renders while its window has focus.
param(
    # Comma- or space-separated (pwsh -File hands a list over as one string).
    [string]$Examples = "",
    [string]$Apis = "dx12,vk",
    [int]$Seconds = 8
)

$exampleList = @($Examples -split "[,\s]+" | Where-Object { $_ })
$apiList = @($Apis -split "[,\s]+" | Where-Object { $_ })

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "build/bin"
$logs = Join-Path $root "build/smoke"
New-Item -ItemType Directory -Force $logs | Out-Null

if ($exampleList.Count -eq 0) {
    $exampleList = @(Get-ChildItem (Join-Path $root "examples/*.ts") |
        ForEach-Object { $_.BaseName } |
        Where-Object { Test-Path (Join-Path $bin "$_.exe") })
}

# Arguments some examples need on every run.
$extraArgs = @{
    "video_texture" = @("-mute")
}

$failures = @()
foreach ($example in $exampleList) {
    $exe = Join-Path $bin "$example.exe"
    if (-not (Test-Path $exe)) {
        $failures += "${example}: not built"
        continue
    }
    foreach ($api in $apiList) {
        $out = Join-Path $logs "$example.$api.out.txt"
        $err = Join-Path $logs "$example.$api.err.txt"
        $arguments = @("-$api", "-debug") + $extraArgs[$example]
        $p = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $bin -NoNewWindow -PassThru `
            -RedirectStandardOutput $out -RedirectStandardError $err
        $finished = $p.WaitForExit($Seconds * 1000)
        if (-not $finished) {
            Stop-Process -Id $p.Id -Force
            $p.WaitForExit()
        }
        $problem = $null
        if ($finished -and $p.ExitCode -ne 0) {
            $problem = "exited with code $($p.ExitCode)"
        }
        $errors = @(Get-Content $out, $err -ErrorAction SilentlyContinue |
            Where-Object { $_ -match "ERROR|Validation Error|D3D12 ERROR|D3D11 ERROR" })
        if ($errors.Count -gt 0) {
            $problem = (@($problem) + "$($errors.Count) error line(s), first: $($errors[0])" | Where-Object { $_ }) -join "; "
        }
        if ($problem) {
            $failures += "$example ($api): $problem"
            Write-Host "FAIL $example ($api): $problem"
        } else {
            Write-Host "ok   $example ($api)"
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "smoke_examples: $($failures.Count) failure(s)"
    $failures | ForEach-Object { Write-Host "  $_" }
    exit 1
}
Write-Host "smoke_examples: all passed"
