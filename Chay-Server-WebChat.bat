@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$base = (Get-Location).Path; $url = 'http://127.0.0.1:3001/health'; $ok = $false; try { $ok = (Invoke-RestMethod -Uri $url -TimeoutSec 2).status -eq 'ok' } catch {}; if (-not $ok) { $node = (Get-Command node -ErrorAction Stop).Source; $out = Join-Path $base 'data\server.log'; $err = Join-Path $base 'data\server-error.log'; Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $base -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err; Start-Sleep -Seconds 2; try { $ok = (Invoke-RestMethod -Uri $url -TimeoutSec 3).status -eq 'ok' } catch {} }; if ($ok) { Start-Process 'http://localhost:3001'; exit 0 } else { exit 1 }"

if errorlevel 1 (
  echo Khong khoi dong duoc server. Kiem tra Node.js va file data\server-error.log.
  pause
)
