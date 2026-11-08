@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem --- pick a modern Node (>=22 provides globalThis.WebSocket); PATH node may be too old ---
set "NODE_EXE=node"
for /d %%D in ("E:\DSH-Data\home\dsh-runtimes\*") do (
    if exist "%%~D\dependencies\node\bin\node.exe" set "NODE_EXE=%%~D\dependencies\node\bin\node.exe"
)
if defined SURFCORE_NODE set "NODE_EXE=%SURFCORE_NODE%"

rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
"%NODE_EXE%" scripts\harden-state-acl.mjs --quiet
:loop
"%NODE_EXE%" src\bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop