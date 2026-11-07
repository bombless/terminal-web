import { createServer } from 'node:http';
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8700);
const HOST = '127.0.0.1';
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const sessions = new Map<WebSocket, ReturnType<typeof spawn>>();

type ClientMessage =
  | { type: 'connect'; shell?: 'ssh' | 'pwsh'; host?: string; username?: string; port?: number; identityFile?: string; cols?: number; rows?: number }
  | { type: 'data'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'disconnect' };
type ForwardMessage = { type: 'start'; host: string; username?: string; sshPort: number; identityFile?: string; remotePort: number; localPort: number } | { type: 'stop' };
const forwardingSessions = new Map<WebSocket, ReturnType<typeof spawnProcess>>();

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

function send(socket: WebSocket, payload: object) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function validOrigin(origin: string | undefined) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return ['127.0.0.1', 'localhost'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol);
  } catch { return false; }
}
function startTerminal(socket: WebSocket, input: Extract<ClientMessage, { type: 'connect' }>) {
  if (sessions.has(socket)) throw new Error('This connection already has an active terminal process.');
  const shell = input.shell ?? 'ssh';
  let executable: string;
  let args: string[];
  if (shell === 'pwsh') {
    executable = 'pwsh.exe';
    args = ['-NoLogo'];
  } else {
    const host = input.host?.trim() ?? '';
    if (!host || host.length > 253 || /[\s\u0000-\u001f]/.test(host) || host.startsWith('-')) {
      throw new Error('Enter a valid SSH host name or IP address.');
    }
    const port = input.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535.');
    args = ['-tt', '-p', String(port)];
    if (input.username?.trim()) args.push('-l', input.username.trim());
    if (input.identityFile?.trim()) args.push('-i', input.identityFile.trim());
    args.push('--', host);
    executable = 'ssh.exe';
  }
  const terminal = spawn(executable, args, {
    name: 'xterm-256color', cols: Math.max(20, Math.min(400, input.cols ?? 100)),
    rows: Math.max(5, Math.min(200, input.rows ?? 30)), cwd: process.env.USERPROFILE,
    // Use node-pty's bundled ConPTY DLL on Windows. The system-ConPTY cleanup path
    // forks conpty_console_list_agent, whose AttachConsole can fail for a shell
    // that has already detached/exited and produces an uncaught child-process error.
    useConptyDll: process.platform === 'win32',
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
  });
  sessions.set(socket, terminal);
  terminal.onData(data => send(socket, { type: 'data', data }));
  terminal.onExit(({ exitCode, signal }) => {
    sessions.delete(socket);
    send(socket, { type: 'exit', exitCode, signal });
  });
  send(socket, { type: 'status', status: 'connected' });
}
function startForwarding(socket: WebSocket, input: Extract<ForwardMessage, { type: 'start' }>) {
  if (forwardingSessions.has(socket)) throw new Error('This connection already has an active forwarding tunnel.');
  const host = input.host?.trim() ?? '';
  if (!host || host.length > 253 || /[\s\u0000-\u001f]/.test(host) || host.startsWith('-')) throw new Error('Select a valid saved SSH host.');
  for (const [value, label] of [[input.sshPort, 'SSH'], [input.remotePort, 'Remote TCP'], [input.localPort, 'Local TCP']] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label} port must be between 1 and 65535.`);
  }
  const args = ['-N', '-T', '-v', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-L', `127.0.0.1:${input.localPort}:127.0.0.1:${input.remotePort}`, '-p', String(input.sshPort)];
  if (input.username?.trim()) args.push('-l', input.username.trim());
  if (input.identityFile?.trim()) args.push('-i', input.identityFile.trim());
  args.push('--', host);
  const tunnel = spawnProcess('ssh.exe', args, { cwd: process.env.USERPROFILE, windowsHide: true, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  forwardingSessions.set(socket, tunnel);
  let stderr = '';
  let tunnelReady = false;
  tunnel.stderr?.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-3000);
    if (!tunnelReady && /Local forwarding listening on/i.test(stderr)) {
      tunnelReady = true;
      send(socket, { type: 'started', localAddress: `127.0.0.1:${input.localPort}`, remoteAddress: `127.0.0.1:${input.remotePort}` });
    }
  });
  tunnel.once('error', error => { forwardingSessions.delete(socket); send(socket, { type: 'error', message: `Unable to launch ssh.exe: ${error.message}` }); });
  tunnel.once('close', (code, signal) => {
    forwardingSessions.delete(socket);
    if (socket.readyState === WebSocket.OPEN && code !== null && code !== 0) send(socket, { type: 'error', message: stderr.trim() || `SSH tunnel exited with code ${code}${signal ? ` (${signal})` : ''}.` });
    else send(socket, { type: 'stopped' });
  });
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    return;
  }
  const requested = normalize(join(dist, pathname === '/' ? 'index.html' : pathname));
  if (requested.startsWith(dist) && existsSync(requested) && statSync(requested).isFile()) {
    res.writeHead(200, { 'content-type': mime[extname(requested)] ?? 'application/octet-stream' });
    res.end(readFileSync(requested));
    return;
  }
  const fallback = join(dist, 'index.html');
  if (existsSync(fallback)) res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(fallback));
  else res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('SSH bridge ready. Run npm run dev for the web app.');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (request, socket, head) => {
  if (!['/terminal', '/forward'].includes(request.url ?? '') || !validOrigin(request.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});
wss.on('connection', (socket, request) => {
  if (request.url === '/forward') {
    socket.on('message', raw => {
      let message: ForwardMessage;
      try { message = JSON.parse(raw.toString()) as ForwardMessage; }
      catch { send(socket, { type: 'error', message: 'Invalid forwarding message format.' }); return; }
      try {
        if (message.type === 'start') startForwarding(socket, message);
        else if (message.type === 'stop') { const tunnel = forwardingSessions.get(socket); if (tunnel) { forwardingSessions.delete(socket); tunnel.kill(); } send(socket, { type: 'stopped' }); }
      } catch (error) { send(socket, { type: 'error', message: error instanceof Error ? error.message : 'Unable to start SSH forwarding.' }); }
    });
    socket.on('close', () => { const tunnel = forwardingSessions.get(socket); if (tunnel) { forwardingSessions.delete(socket); tunnel.kill(); } });
    return;
  }
  socket.on('message', raw => {
    let message: ClientMessage;
    try { message = JSON.parse(raw.toString()) as ClientMessage; }
    catch { send(socket, { type: 'error', message: 'Invalid message format.' }); return; }
    try {
      if (message.type === 'connect') startTerminal(socket, message);
      else if (message.type === 'data') sessions.get(socket)?.write(message.data);
      else if (message.type === 'resize') {
        const terminal = sessions.get(socket);
        if (terminal) terminal.resize(Math.max(20, Math.min(400, Math.floor(message.cols))), Math.max(5, Math.min(200, Math.floor(message.rows))));
      } else if (message.type === 'disconnect') { sessions.get(socket)?.kill(); sessions.delete(socket); }
    } catch (error) {
      send(socket, { type: 'error', message: error instanceof Error ? error.message : 'Unable to start SSH.' });
    }
  });
  socket.on('close', () => { sessions.get(socket)?.kill(); sessions.delete(socket); });
});
server.listen(PORT, HOST, () => console.log('Terminal SSH bridge listening at http://' + HOST + ':' + PORT));
