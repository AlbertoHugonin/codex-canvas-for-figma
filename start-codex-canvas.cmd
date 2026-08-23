@echo off
setlocal
title Codex Canvas for Figma
cd /d "%~dp0"

echo Avvio di Codex Canvas for Figma...
echo Chiudi questa finestra per fermare il bridge.
echo.

call npm start
set "CODEX_CANVAS_EXIT=%ERRORLEVEL%"

echo.
if not "%CODEX_CANVAS_EXIT%"=="0" (
  echo Codex Canvas si e' fermato con errore %CODEX_CANVAS_EXIT%.
) else (
  echo Codex Canvas e' stato fermato.
)
echo Premi un tasto per chiudere questa finestra.
pause >nul
exit /b %CODEX_CANVAS_EXIT%
