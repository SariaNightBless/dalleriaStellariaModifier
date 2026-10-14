@echo off
rem ============================================================================================
rem  uninstall.cmd —— 一键卸载：把游戏还原成没装过本修改器的样子（双击即可）
rem
rem  用法：
rem    uninstall.cmd                          卸**本包的上一级目录**（把包放进实例里的默认摆法）→ 确认 → 还原
rem    uninstall.cmd --root "D:\你的游戏目录"   指定别的游戏目录
rem    uninstall.cmd --root "D:\..." --yes     不问确认，直接还原
rem    uninstall.cmd --list                    只列出找过的候选目录，不改任何东西
rem    uninstall.cmd --clean                   还原之后，顺手删掉内容合并缓存 .cache\mods
rem
rem  默认目标与 deploy.cmd 同源：包放在 <游戏目录>\<包>\ 里，游戏根就是本包的 `..`。
rem  装到别处去的那一份（比如用 --root 装的），靠 state\ 里的安装记录认回来。
rem
rem  还原是**按安装记录**做的（state\<键>.json + state\backup\）：
rem    · 上游文件逐字节还原（装完之后又被你改过的那些**不动**，只提示）；
rem    · 本修改器自己的文件删掉。
rem  ⚠️ 实例的 mods\ 目录**原样保留** —— 你的模组包不会被删。
rem  想连缓存一起清，加 --clean。
rem ============================================================================================
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title 模组加载器 · 卸载

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "ROOT="
set "WANT_YES="
set "WANT_CLEAN="
set "MODE=undo"
set "A1=%~1"
if /i "%A1%"=="--list" set "MODE=list"

echo.
echo   ============================================================
echo    卫戍协议：盟约  ·  模组加载器  ·  卸载（还原上游）
echo   ============================================================
echo.

rem ---- 1) 找 node ---------------------------------------------------------------------------
call "%HERE%\findnode.cmd"
if not defined NODE (
  echo   [X] 找不到 Node.js。三步：
  echo       1^) winget install OpenJS.NodeJS.LTS
  echo       2^) 或先 set NODE=C:\你的路径\node.exe 再跑本脚本
  echo       3^) 或把 node.exe 复制到本包目录里
  echo.
  pause
  exit /b 1
)
set "NODEV="
for /f "delims=" %%v in ('"%NODE%" --version 2^>nul') do set "NODEV=%%v"
echo   使用 Node：%NODE%  %NODEV%

rem ---- 2) 参数 -------------------------------------------------------------------------------
rem 与 deploy.cmd 同一套口径：位置无关地扫。`uninstall.cmd --yes --root "D:\游戏"` 与
rem `uninstall.cmd --root "D:\游戏" --yes --clean` 都得认。--root 的路径交给 which.mjs 解析
rem （批处理的 for 会把引号拆掉，带空格的路径拼不回来）。
set "WANT_YES="
set "WANT_CLEAN="
set "WANT_ROOT="
set "ROOTARGS="
set "WANT_UNKNOWN="
set "INROOT="
for %%a in (%*) do (
  if /i "%%a"=="--yes" set "WANT_YES=1"
  if /i "%%a"=="--clean" set "WANT_CLEAN=1"
  if defined INROOT set "ROOTARGS=!ROOTARGS! %%a"
  if not defined INROOT (
    if /i "%%a"=="--root" (
      set "WANT_ROOT=1" & set "INROOT=1"
    ) else (
      if /i not "%%a"=="--yes" if /i not "%%a"=="--clean" if /i not "%%a"=="--list" set "WANT_UNKNOWN=%%a"
    )
  )
)

if /i "%MODE%"=="list" goto run_list

rem ---- 3) 找游戏目录 + 确认装过 ---------------------------------------------------------------
echo.
if defined WANT_UNKNOWN (
  echo   [X] 不认识的参数：!WANT_UNKNOWN!
  echo       用法：uninstall.cmd [--root "游戏目录"] [--yes] [--clean^|--list]
  echo.
  pause
  exit /b 2
)
if defined WANT_ROOT if not defined ROOT call :resolve_root
if defined WANT_ROOT if not defined ROOT (
  echo   [X] --root 后面缺目录（或者路径里有 cmd 不认的引号）。
  echo       例：uninstall.cmd --root "D:\你的游戏目录"
  echo.
  pause
  exit /b 2
)
if not defined ROOT call :locate || goto no_record
echo   游戏目录：%ROOT%

set "PROBE="
if not defined ROOT goto no_root
rem 让 which.mjs --probe 直接写状态文件，再由 set /p 读回来。
rem ⚠️ 不走 `for /f … in ('"程序" … --probe 2^>nul')`：那种引法会静默什么都不输出，
rem    于是"有没有装过"永远判成"没有"，卸载直接变成"无事可做"。
if not exist "%HERE%\state" mkdir "%HERE%\state" >nul 2>&1
set "PROBETMP=%HERE%\state\.probe.tmp"
if exist "%PROBETMP%" del "%PROBETMP%" >nul 2>&1
"%NODE%" "%HERE%\which.mjs" --root "%ROOT%" --probe --out "%PROBETMP%" >nul 2>&1
if exist "%PROBETMP%" set /p "PROBE="<"%PROBETMP%"
if exist "%PROBETMP%" del "%PROBETMP%" >nul 2>&1
if not defined PROBE (
  echo.
  echo   [!] 找不到安装记录：这个目录不在本包的 state\ 里 —— 说明这份修改器没有装到这儿，或者已经还原过了。
  echo       ^(备份与记录被删掉的话，--undo 就没法逐字节还原，只能拿一份干净的上游覆盖回来^)
  echo.
  pause
  exit /b 0
)
echo   [记录] %PROBE%

rem ---- 4) 还原 -------------------------------------------------------------------------------
echo.
if defined WANT_CLEAN echo   ^(--clean：还原之后还会删掉内容合并缓存 %ROOT%\.cache\mods^)
if defined WANT_YES goto go
set "ANS="
set /p "ANS=  把这个目录还原成没装过的样子？改动的是上游文件，你的 mods\ 不动。[Y/n] "
if /i "%ANS%"=="n" goto cancel
if /i "%ANS%"=="no" goto cancel

:go
echo.
"%NODE%" "%HERE%\install.mjs" --undo --root "%ROOT%"
set "RC=!errorlevel!"
if not "!RC!"=="0" goto done

rem 还原成功 → 这份「上次装到哪」的记录作废（安装记录本身由 install.mjs 删掉）
if exist "%HERE%\state\last-root.txt" del "%HERE%\state\last-root.txt" >nul 2>&1
set "CLEANRC=0"
if defined WANT_CLEAN (
  echo.
  "%NODE%" "%HERE%\install.mjs" --clean --root "%ROOT%"
  set "CLEANRC=!errorlevel!"
)
echo.
echo   ── 还原后自检（看到"缺 / 未接线"正是没装过的样子）───────────
"%NODE%" "%HERE%\install.mjs" --verify --root "%ROOT%"
echo.
echo   ^(上面这份自检**只报状态**，不影响退出码 —— 卸载成功就是成功^)
if not "!CLEANRC!"=="0" set "RC=!CLEANRC!"
goto done

:locate
rem 与 deploy.cmd 同一套判定（which.mjs）：两个脚本不可能对"游戏在哪"给出不同答案
if not exist "%HERE%\state" mkdir "%HERE%\state" >nul 2>&1
set "WHICHTMP=%HERE%\state\.which.tmp"
if exist "%WHICHTMP%" del "%WHICHTMP%" >nul 2>&1
"%NODE%" "%HERE%\which.mjs" --out "%WHICHTMP%" >nul 2>&1
set "WRC=!errorlevel!"
if not "!WRC!"=="0" (
  if exist "%WHICHTMP%" del "%WHICHTMP%" >nul 2>&1
  exit /b 1
)
set "ROOT="
if exist "%WHICHTMP%" set /p "ROOT="<"%WHICHTMP%"
if exist "%WHICHTMP%" del "%WHICHTMP%" >nul 2>&1
if defined ROOT exit /b 0
exit /b 1

:resolve_root
rem 把 --root 后面的路径解出来（批处理不自己拼 —— 引号会被 for 拆掉），交给 node 的 argv。
if not exist "%HERE%\state" mkdir "%HERE%\state" >nul 2>&1
set "WHICHTMP=%HERE%\state\.root.tmp"
if exist "%WHICHTMP%" del "%WHICHTMP%" >nul 2>&1
rem stdout 一并吞掉：--resolve 除了写 --out 还会把路径打到屏幕上（单独手跑时有用），批处理里不要这行噪音。
"%NODE%" "%HERE%\which.mjs" --root %ROOTARGS% --resolve --out "%WHICHTMP%" >nul 2>&1
set "ROOT="
if exist "%WHICHTMP%" set /p "ROOT="<"%WHICHTMP%"
if exist "%WHICHTMP%" del "%WHICHTMP%" >nul 2>&1
if defined ROOT exit /b 0
exit /b 1

:no_root
echo.
echo   找不到游戏目录。把它手输进来（回车 = 放弃）—— 里面要有 server\index.js、public\index.html、package.json。
echo   包放进实例里（^<游戏目录^>\dalleriaStellariaModifier1x\）时，默认目标就是它的上一级，不需要手输。
echo.
set "ANS="
set /p "ANS=  游戏目录："
if not defined ANS goto cancel
if not exist "%ANS%\server\index.js" (
  echo.
  echo   [X] %ANS% 里没有 server\index.js —— 不像游戏目录，放弃。
  goto cancel
)
set "ROOT=%ANS%"
goto go

:no_record
echo.
echo   [!] 找不到要卸载的安装记录。
echo       本包的 state\ 里没有这份记录、自动也找不到游戏目录 —— 说明这份修改器没有装过，或者已经还原过了。
echo       （备份与记录如果被删掉，--undo 就没法逐字节还原；那种情况只能拿一份干净的上游覆盖回来）
echo       想指到某个目录自己看：uninstall.cmd --root "D:\你的游戏目录"
echo.
pause
exit /b 0

:run_list
echo   找过的候选（good = 游戏根，soft = 缺些上游记号，bad = 不是）：
echo.
"%NODE%" "%HERE%\which.mjs" --list
echo.
pause
exit /b 0

:cancel
echo.
echo   已取消，什么都没改。
echo.
pause
exit /b 0

:done
echo.
if not "!RC!"=="0" (
  echo   [!] 还原过程有提示，详见上面的输出 —— 逐条看一眼再决定要不要重跑。
) else (
  echo   [OK] 已卸载：上游文件按备份逐字节还原，本修改器的文件已删除。
  echo        你自己的 mods\ 目录还在（现在没有加载器去读它了）。
  echo        重启游戏服务器即完全恢复原样。
)
echo.
pause
exit /b !RC!
