@echo off
setlocal
set "SHIM_DIR=%~dp0"
if defined BUN (set "BUN_BIN=%BUN%") else (set "BUN_BIN=bun")
"%BUN_BIN%" "%SHIM_DIR%..\git-guard.ts" %*
exit /b %ERRORLEVEL%
