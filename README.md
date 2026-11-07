# Terminal Web

A Windows-first browser terminal workspace with a ChatGPT-inspired session sidebar and an xterm.js terminal. Supports remote SSH and a local PowerShell 7 (`pwsh.exe`) shell.

## Requirements

- Windows 10/11
- Node.js 20+
- Windows OpenSSH Client (ssh.exe) available on PATH
- PowerShell 7 (pwsh.exe) available on PATH for local PowerShell sessions
- Windows C++ build tools may be needed by node-pty if a prebuilt binary is unavailable

## Run locally

```powershell
npm install
npm run dev
```

Open http://127.0.0.1:5173. The SSH bridge listens on http://127.0.0.1:8700.

Production:

```powershell
npm run build
npm start
```

Then open http://127.0.0.1:8700.

## SSH and terminal behavior

The bridge starts ssh.exe directly (not through a shell) with -tt to request a remote PTY, or starts pwsh.exe directly for a local PowerShell 7 session. node-pty hosts either process in a Windows ConPTY, allowing interactive terminal input, Ctrl+C, resize/window-change, ANSI sequences, alternate screen buffers and TUI applications such as Codex.

SSH authentication is delegated to the native OpenSSH client. Leave Identity File blank to use normal OpenSSH behavior: %USERPROFILE%\\.ssh\\config, default identity files, ssh-agent and normal host-key verification. An optional identity file is passed as ssh.exe -i. Private-key contents are never uploaded to the browser or stored by this app.

## Architecture

- React + TypeScript + Vite UI
- xterm.js with Fit and Web Links addons
- Node.js WebSocket bridge bound to loopback only
- node-pty creates Windows ConPTY and runs ssh.exe or pwsh.exe
- Saved connection profiles live in browser localStorage; no credentials or key contents are stored

The bridge validates browser origins and accepts WebSocket upgrades only from localhost origins. Do not expose the bridge port to your LAN or the public internet without adding authentication and an explicit network security model.
