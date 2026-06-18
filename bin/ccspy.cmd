@echo off
setlocal
rem ccspy — run Claude Code through the cc-scope observation proxy.
set "CCSCOPE_DIR=%~dp0.."
rem Behind a TLS-inspecting proxy? Set NODE_EXTRA_CA_CERTS to your root CA PEM.
rem Otherwise auto-detect the Cloudflare WARP cert if it happens to be present.
if not defined NODE_EXTRA_CA_CERTS if exist "C:\ProgramData\Cloudflare\installed_cert.pem" set "NODE_EXTRA_CA_CERTS=C:\ProgramData\Cloudflare\installed_cert.pem"

rem Start the server if the dashboard isn't answering.
node -e "fetch('http://127.0.0.1:4001/api/ping').then(r=>process.exit(0)).catch(()=>process.exit(1))" >NUL 2>&1
if errorlevel 1 (
  echo [ccspy] starting cc-scope server...
  start "cc-scope" /min cmd /c "node "%CCSCOPE_DIR%\server.js""
  rem wait for it to come up (max ~5s)
  for /l %%i in (1,1,10) do (
    node -e "fetch('http://127.0.0.1:4001/api/ping').then(r=>process.exit(0)).catch(()=>process.exit(1))" >NUL 2>&1 && goto up
    ping -n 2 127.0.0.1 >NUL
  )
)
:up
echo [ccspy] dashboard: http://127.0.0.1:4001
endlocal & set "ANTHROPIC_BASE_URL=http://127.0.0.1:4000" & if exist "C:\ProgramData\Cloudflare\installed_cert.pem" if not defined NODE_EXTRA_CA_CERTS set "NODE_EXTRA_CA_CERTS=C:\ProgramData\Cloudflare\installed_cert.pem"
claude %*
