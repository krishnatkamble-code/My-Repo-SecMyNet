@echo off
setlocal
set DIR=%~dp0
call "%DIR%gradle.bat" %*
