@echo off
setlocal
set "ANIBT_NODE="
if exist "%~dp0runtime\node.exe" set "ANIBT_NODE=%~dp0runtime\node.exe"
if not defined ANIBT_NODE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined ANIBT_NODE set "ANIBT_NODE=%%I"
if not defined ANIBT_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "ANIBT_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined ANIBT_NODE (
  echo Node.js 22+ is required. Please install Node.js or place node.exe in runtime.
  exit /b 1
)
pushd "%~dp0"
"%ANIBT_NODE%" "%~dp0dist\anibt-qb.mjs" %*
set "ANIBT_RESULT=%ERRORLEVEL%"
popd
exit /b %ANIBT_RESULT%
