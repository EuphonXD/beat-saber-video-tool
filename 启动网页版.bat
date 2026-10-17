@echo off
chcp 65001 >nul
title Beat Saber Video Tool (Web)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)
node --check server.js
if errorlevel 1 (
  echo [X] server.js syntax check failed. Please report this to the assistant.
  pause
  exit /b 1
)
node server.js
if errorlevel 1 pause
