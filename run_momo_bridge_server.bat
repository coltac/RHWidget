@echo off
setlocal

pushd "%~dp0" || exit /b 1

if not exist "momo_bridge_server.py" (
  echo ERROR: Could not find momo_bridge_server.py in "%cd%".
  echo        Place this .bat next to momo_bridge_server.py and try again.
  popd
  pause
  exit /b 1
)

set "PYEXE="
set "PYARGS="
if exist ".venv\Scripts\python.exe" set "PYEXE=.venv\Scripts\python.exe"
if not defined PYEXE if exist "venv\Scripts\python.exe" set "PYEXE=venv\Scripts\python.exe"
if not defined PYEXE (
  where python >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
  where py >nul 2>nul && (set "PYEXE=py" & set "PYARGS=-3")
)

if not defined PYEXE (
  echo ERROR: Python not found.
  echo        Install Python 3 and/or create a venv at .venv\ then try again.
  popd
  pause
  exit /b 1
)

if /I "%~1"=="--setup" (
  shift
  echo.
  echo --- Setup: creating venv + installing deps ---
  if not exist ".venv\Scripts\python.exe" (
    call "%PYEXE%" %PYARGS% -m venv .venv
    if errorlevel 1 (
      echo ERROR: Failed to create .venv
      popd
      pause
      exit /b 1
    )
  )

  call ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo ERROR: Failed to install requirements.txt
    popd
    pause
    exit /b 1
  )

  call ".venv\Scripts\python.exe" -m playwright install chromium
  if errorlevel 1 (
    echo ERROR: Failed to install Playwright Chromium
    popd
    pause
    exit /b 1
  )

  set "PYEXE=.venv\Scripts\python.exe"
  set "PYARGS="
  echo --- Setup complete ---
  echo.
)

echo Running: "%PYEXE%" %PYARGS% momo_bridge_server.py %*
call "%PYEXE%" %PYARGS% momo_bridge_server.py %*
set "EXITCODE=%ERRORLEVEL%"

popd

if not "%EXITCODE%"=="0" (
  echo.
  echo momo_bridge_server.py exited with code %EXITCODE%.
  pause
)

exit /b %EXITCODE%
