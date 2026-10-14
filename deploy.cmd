@echo off
setlocal
chcp 65001 >nul
set "HERE=%~dp0"
set "ROOT=%HERE%.."
for %%i in ("%ROOT%") do set "ROOT=%%~fi"
if not exist "%ROOT%\server\index.js" set "ROOT=D:\sp\version\test"
for /f "tokens=2 delims='" %%a in ('findstr /b /c:"export const LOADER_VERSION" "%HERE%version.mjs"') do set "VER=%%a"
if not defined VER set "VER=?"
echo %VER%
echo.
echo %ROOT%
echo.
set /p "ANS=y/n ? "
if /i not "%ANS%"=="y" exit /b 1
echo.
echo.
echo 安装中...
node "%HERE%install.mjs" --root "%ROOT%" >nul 2>&1
set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (echo 安装完成) else (echo 安装失败)
echo.
echo 按任意键退出...
pause >nul
endlocal
