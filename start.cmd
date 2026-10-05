@echo off
rem Opens AgentDeck in your default browser, with a console you can watch.
pushd "%~dp0"
node server.js --browser
if errorlevel 1 pause
popd
