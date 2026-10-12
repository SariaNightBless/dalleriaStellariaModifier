@echo off
rem ============================================================================================
rem  deploy.cmd —— 一键部署：把本修改器装进游戏目录（双击即可）
rem
rem  用法：
rem    deploy.cmd                          自动找游戏目录 → 装 → 自检
rem    deploy.cmd --root "D:\你的游戏目录"   指定游戏目录
rem    deploy.cmd --root "D:\..." --yes     不问确认，直接装
rem    deploy.cmd --audit                   只逐条试补丁锚点，不改任何文件（换新上游时第一步跑它）
rem    deploy.cmd --verify                  只看现在装没装好，不改任何文件
rem
rem  它自己**不会**复制任何模组包：模组包留在实例的 mods\ 目录里，
rem  用游戏里的「模组」按钮 → /mods.html 拖进去。
rem  对应的卸载：uninstall.cmd（游戏目录由 which.mjs 判定，两边认的是同一个）
rem ============================================================================================
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title 模组加载器 · 部署

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "ROOT="
set "WANT_YES="
set "MODE=install"

rem ⚠️ 参数一律按「位置无关」扫，别写 `if "%~1"=="--root"`：
rem    `deploy.cmd --verify --root "D:\游戏"` 里 --root 是第 2 个参数，按位置判会**静默忽略**它，
rem    然后退回自动查找 —— 用户以为装到了自己指的目录，实际装去了另一个（这坑真踩过）。
rem ⚠️ 也别在批处理里自己拼 `--root` 后面的路径：`for %%a in (%*)` 会把引号拆掉，
rem    `--root "D:\my game"` 碎成两个 token；这里只记下"剩下的参数原文"，交给
rem    which.mjs --resolve 去解析（node 的 argv 本来就认得带引号 / 带空格的路径）。
set "A1=%~1"
if /i "%A1%"=="--audit" set "MODE=audit"
if /i "%A1%"=="--verify" set "MODE=verify"
if /i "%A1%"=="--list" set "MODE=list"

set "WANT_YES="
set "WANT_ROOT="
set "ROOTARGS="
set "WANT_UNKNOWN="
set "INROOT="
for %%a in (%*) do (
  if /i "%%a"=="--yes" set "WANT_YES=1"
  if defined INROOT set "ROOTARGS=!ROOTARGS! %%a"
  if not defined INROOT (
    if /i "%%a"=="--root" (
      set "WANT_ROOT=1" & set "INROOT=1"
    ) else (
      if /i not "%%a"=="--yes" if /i not "%%a"=="--verify" if /i not "%%a"=="--audit" if /i not "%%a"=="--list" set "WANT_UNKNOWN=%%a"
    )
  )
)

echo.
echo   ============================================================
echo    卫戍协议：盟约  ·  模组加载器  ·  部署
echo    本修改器文件 + 上游接线（改上游哪几行见 patches.mjs）
echo   ============================================================
echo.

rem ---- 1) 找 node ---------------------------------------------------------------------------
call "%HERE%\findnode.cmd"
if not defined NODE (
  echo   [X] 找不到 Node.js。本游戏要 Node 22 或更高。三种办法：
  echo.
  echo       1^) 装一个：  winget install OpenJS.NodeJS.LTS
  echo       2^) 已经装了但在非常规位置，先在命令行里设好再跑本脚本：
  echo              set NODE=C:\你的路径\node.exe
  echo.
  echo       3^) 把 node.exe 直接复制到本包目录（或本包 node\ 子目录）里，再双击本文件
  echo.
  pause
  exit /b 1
)
set "NODEV="
for /f "delims=" %%v in ('"%NODE%" --version 2^>nul') do set "NODEV=%%v"
echo   使用 Node：%NODE%  %NODEV%
set "NODEMAJOR="
for /f "delims=" %%m in ('"%NODE%" -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2^>nul') do set "NODEMAJOR=%%m"
if defined NODEMAJOR if !NODEMAJOR! LSS 22 echo   [!] 这个 Node 是 %NODEV%，本游戏要求 22 或更高 —— 继续装，但可能起不来。

rem ---- 2) 找游戏目录（which.mjs 是唯一判定点） ----------------------------------------------
echo.
if defined WANT_UNKNOWN (
  echo   [X] 不认识的参数：!WANT_UNKNOWN!
  echo       用法：deploy.cmd [--root "游戏目录"] [--yes] [--audit^|--verify^|--list]
  echo.
  pause
  exit /b 2
)
if defined WANT_ROOT if not defined ROOT call :resolve_root
if defined WANT_ROOT if not defined ROOT (
  echo   [X] --root 后面缺目录（或者路径里有 cmd 不认的引号）。
  echo       例：deploy.cmd --root "D:\sp\version\test"
  echo.
  pause
  exit /b 2
)

if /i "%MODE%"=="list" goto run_list
if not defined ROOT call :locate || goto no_root

rem ---- 3) 报告要装到哪、那儿现在是什么样 -----------------------------------------------------
echo   游戏目录：%ROOT%
echo.
rem ⚠️ 在 for /f 里收命令输出、且命令里还带重定向时，引号要写成 `cmd /c "… 2^>nul"` 才转得过去；
rem    少一层就**静默什么都不输出**（这一屏预览会变成空行，还不报错）。这坑真踩过。
for /f "delims=" %%l in ('cmd /c ""%NODE%" "%HERE%\install.mjs" --verify --root "%ROOT%" 2^>nul"') do echo   %%l
echo.

if /i "%MODE%"=="verify" (
  echo   [--verify] 只核对、没有改任何文件。
  echo.
  pause
  exit /b 0
)
if /i "%MODE%"=="audit" (
  echo   跑补丁锚点自检（不改任何文件）……
  echo.
  "%NODE%" "%HERE%\install.mjs" --audit --root "%ROOT%"
  set "RC=!errorlevel!"
  goto done
)
if defined WANT_YES goto go
set "ANS="
set /p "ANS=  现在把修改器装进这个目录？[Y/n] "
if /i "%ANS%"=="n" goto cancel
if /i "%ANS%"=="no" goto cancel

:go
echo.
"%NODE%" "%HERE%\install.mjs" --root "%ROOT%"
set "RC=!errorlevel!"
if not "!RC!"=="0" goto done

rem 装成功了才记「上次装到哪」—— 这份记录是 uninstall.cmd 的兜底
if not exist "%HERE%\state" mkdir "%HERE%\state" >nul 2>&1
>"%HERE%\state\last-root.txt" echo %ROOT%

echo.
echo   ── 装完自检 ──────────────────────────────────────────────
"%NODE%" "%HERE%\install.mjs" --verify --root "%ROOT%"
set "RC=!errorlevel!"
goto done

:locate
rem 交给 node 判：--root 独占；否则查 state 记录 → SP_GAME_ROOT → 常见摆法。
rem 让 which.mjs 用 --out 直接写文件，再由 set /p 读回来 —— 绕开 for /f 里那套引号机关
rem （那条路踩过坑：引号少一层就静默什么都不输出）。路径里带空格 / 中文都不受影响。
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
rem 把 --root 后面的路径解出来。批处理不自己拼（引号会被 for 拆掉），交给 node：
rem ROOTARGS 是"紧跟 --root 之后的参数原文"，原样透传，node 的 argv 认得带引号 / 带空格的路径。
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
echo   你可以现在手输游戏目录（回车 = 放弃）。它里面要有 server\index.js、public\index.html、package.json。
echo   例： D:\sp\version\test
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
  echo   [X] 有 %RC% 处问题，详见上面的输出。修好再跑一次即可（重复安装是幂等的）。
) else (
  echo   [OK] 部署完成。
  echo.
  echo        1^) 重启游戏服务器，改动才会生效；
  echo        2^) 进游戏后顶栏（以及打了 title-buttons 接线时的标题页）会多出「模组」按钮；
  echo        3^) 模组包放进  %ROOT%\mods\  或从 /mods.html 拖 zip 进去。
)
echo.
pause
exit /b !RC!
