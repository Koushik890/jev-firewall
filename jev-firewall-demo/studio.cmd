@echo off
cd /d "%~dp0"
npx remotion studio --no-open --log=verbose --port=3000 > studio.log 2>&1
