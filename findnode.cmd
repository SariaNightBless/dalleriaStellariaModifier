@echo off
rem ============================================================================================
rem  findnode.cmd —— 找一个可用的 node，结果放在 %NODE% 里（找不到则 %NODE% 为空）。
rem  deploy.cmd / uninstall.cmd 共用，避免"找 node"的逻辑各写一份、各自漂移。
rem
rem  ⚠️ 不要用 C:\Users\%USERNAME% —— 环境变量 USERNAME 与**用户目录名**不一定相同
rem     （本机两者就不一致，用户目录名常带数字后缀）。要用 %USERPROFILE%。
rem  ⚠️ 只找不改：本文件不设 %NODE% 之外的任何变量，不写任何文件。
rem ============================================================================================

set "NODE="

rem 1) PATH 里有没有
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE set "NODE=%%i"
)

rem 2) 本包自带的（把 node.exe 放进本包根或本包 node\ 里即可，最保险）
if not defined NODE if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if not defined NODE if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"

rem 3) 常见安装位置
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

rem 4) 本机其它已知位置（用 USERPROFILE，不用 USERNAME）
if not defined NODE if exist "%USERPROFILE%\.dsh-win\node\node.exe" set "NODE=%USERPROFILE%\.dsh-win\node\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\node\node.exe" set "NODE=%LOCALAPPDATA%\Programs\node\node.exe"
if not defined NODE if exist "D:\nodejs\node.exe" set "NODE=D:\nodejs\node.exe"
if not defined NODE if exist "D:\node\node.exe" set "NODE=D:\node\node.exe"

rem 5) nvm / fnm / volta / scoop 这类版本管理器（取版本号最大的那个）
if not defined NODE if exist "%APPDATA%\nvm" (
  for /f "delims=" %%v in ('dir /b /o-n "%APPDATA%\nvm\v*.exe" 2^>nul') do (
    if not defined NODE set "NODE=%APPDATA%\nvm\%%v"
  )
)
if not defined NODE if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE=%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined NODE if exist "%USERPROFILE%\scoop\shims\node.exe" set "NODE=%USERPROFILE%\scoop\shims\node.exe"

exit /b 0
