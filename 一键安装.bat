@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

rem ============================================================
rem  随手问 · 一键安装（Windows）
rem  双击运行即可：装 DSH 插件 → 告诉你扩展怎么装
rem  真正的安装在 scripts\install.mjs（macOS / Linux 共用同一份逻辑）
rem ============================================================

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

echo.
echo  随手问 · 一键安装
echo  ----------------
echo.

rem --- 1. 检查 Node.js ---
where node >nul 2>nul
if not !errorlevel!==0 (
  echo [x] 找不到 Node.js。
  echo     随手问要 Node.js 24.9 或更新：https://nodejs.org/
  echo     装完重启这个窗口再来一次。
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODEV=%%v"
echo [1/3] Node.js !NODEV!

rem --- 2. 检查安装脚本 ---
if not exist "%HERE%\scripts\install.mjs" (
  echo [x] 这个文件夹里没有 scripts\install.mjs
  echo     你可能只解压了一半，或者点的不是仓库根目录的 bat。
  pause
  exit /b 1
)

rem --- 3. 装插件（参数原样透传，比如 --dry-run、--help、--port 3999）---
echo [2/3] 装 DSH 插件（会备份改动前的配置）
echo.
node "%HERE%\scripts\install.mjs" %*
set "RC=!errorlevel!"
echo.
if not "!RC!"=="0" (
  echo [x] 插件没装上（退出码 !RC!）。上面的输出里有原因。
  echo     实在不行把这段输出发给 https://github.com/pydsl43/suishouwen/issues
  pause
  exit /b !RC!
)

echo [3/3] 完成。
echo.
rem 双击（没参数）时停一下，让窗口别一闪就关；
rem 命令行带参数跑（比如 --help、--dry-run）不停，方便脚本调用。
if "%~1"=="" pause
endlocal
exit /b 0
