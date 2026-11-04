@echo off
rem Starts the free transcription worker. Keep this window open (or minimised) while classes are processing.
cd /d "%~dp0"
title Halaqa Notes worker
:loop
call npx tsx worker\src\index.ts
echo Worker stopped - restarting in 10 seconds (close this window to stop)...
timeout /t 10 >nul
goto loop
