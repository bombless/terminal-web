import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Activity, ArrowLeftRight, ChevronDown, Command, Menu, Monitor, Play, Plus, Server, ShieldCheck, Square, SquareTerminal, TerminalSquare, Trash2, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

type SavedSession = { id: string; title: string; host: string; username: string; port: number; identityFile: string; shell?: 'ssh' | 'pwsh'; updatedAt: number };
const STORAGE_KEY = 'terminal-web.sessions';
const starter: SavedSession[] = [{ id: 'welcome', title: 'New connection', host: '', username: '', port: 22, identityFile: '', updatedAt: Date.now() }];
function loadSessions(): SavedSession[] {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as SavedSession[]; return value.length ? value : starter; }
  catch { return starter; }
}

export default function App() {
  const [sessions, setSessions] = useState<SavedSession[]>(loadSessions);
  const [activeId, setActiveId] = useState(sessions[0]?.id ?? 'welcome');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showConnect, setShowConnect] = useState(false);
  const [host, setHost] = useState(sessions[0]?.host ?? '');
  const [username, setUsername] = useState(sessions[0]?.username ?? '');
  const [port, setPort] = useState(String(sessions[0]?.port ?? 22));
  const [identityFile, setIdentityFile] = useState(sessions[0]?.identityFile ?? '');
  const [shell, setShell] = useState<'ssh' | 'pwsh'>('ssh');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [error, setError] = useState('');
  const [clock, setClock] = useState('TERMINAL');
  const [forwardHostId, setForwardHostId] = useState('');
  const [remoteForwardPort, setRemoteForwardPort] = useState('');
  const [localForwardPort, setLocalForwardPort] = useState('');
  const [forwardStatus, setForwardStatus] = useState<'idle' | 'starting' | 'active' | 'error'>('idle');
  const [forwardError, setForwardError] = useState('');
  const [forwardAddress, setForwardAddress] = useState('');
  const [activeForward, setActiveForward] = useState<{ host: string; username: string; remotePort: number; localPort: number } | null>(null);
  const [showForwarding, setShowForwarding] = useState(false);
  const forwardSocket = useRef<WebSocket | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const sessionSockets = useRef(new Map<string, WebSocket>());
  const terminalBuffers = useRef(new Map<string, string>());
  const active = sessions.find(item => item.id === activeId) ?? sessions[0];
  const recentSshSessions = sessions.filter(item => item.shell !== 'pwsh' && item.host.trim()).sort((a, b) => b.updatedAt - a.updatedAt);

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions)); }, [sessions]);
  useEffect(() => {
    const update = () => setClock(new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date()));
    update(); const timer = window.setInterval(update, 30000); return () => window.clearInterval(timer);
  }, []);

  const closeSocket = useCallback(() => { socket.current?.close(); socket.current = null; setStatus('idle'); }, []);

  useEffect(() => {
    if (!terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true, convertEol: false, fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13, lineHeight: 1.35, scrollback: 5000, allowProposedApi: true,
      theme: { background: '#171717', foreground: '#e5e5e5', cursor: '#f5f5f5', cursorAccent: '#171717', selectionBackground: '#454545', black: '#171717', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#67e8f9', white: '#e5e5e5', brightBlack: '#737373', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#a5f3fc', brightWhite: '#fafafa' }
    });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.loadAddon(new WebLinksAddon()); terminal.open(terminalRef.current);
    term.current = terminal; requestAnimationFrame(() => fit.fit());
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    });
    observer.observe(terminalRef.current);
    const bufferedOutput = terminalBuffers.current.get(activeId);
    // Replaying a terminal transcript can trigger xterm device-query replies
    // (for example DA1: ESC[?1;2c). Those are emulator responses, not user
    // keystrokes, and must never be sent back to the live SSH shell.
    let replaying = Boolean(bufferedOutput);
    const input = terminal.onData(data => {
      if (replaying) return;
      const activeSocket = sessionSockets.current.get(activeId);
      if (activeSocket?.readyState === WebSocket.OPEN) activeSocket.send(JSON.stringify({ type: 'data', data }));
    });
    if (bufferedOutput) terminal.write(bufferedOutput, () => { replaying = false; });
    return () => { input.dispose(); observer.disconnect(); terminal.dispose(); term.current = null; };
  }, [activeId, status === 'connected']);

  useEffect(() => () => {
    sessionSockets.current.forEach(ws => ws.close());
    sessionSockets.current.clear();
    closeSocket();
  }, [closeSocket]);

  const connect = (event?: FormEvent, saved?: SavedSession) => {
    event?.preventDefault();
    const targetShell = saved?.shell ?? shell;
    const targetHost = saved?.host ?? host;
    const targetUsername = saved?.username ?? username;
    const sshPort = saved?.port ?? Number(port);
    const targetIdentity = saved?.identityFile ?? identityFile;
    if (targetShell === 'ssh' && !targetHost.trim()) { setError('Please enter a host name or IP address.'); return; }
    if (targetShell === 'ssh' && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) { setError('Port must be between 1 and 65535.'); return; }
    const sessionId = saved?.id ?? activeId;
    sessionSockets.current.get(sessionId)?.close();
    sessionSockets.current.delete(sessionId);
    socket.current = null;
    setError(''); setStatus('connecting'); setShowConnect(false);
    term.current?.clear();
    terminalBuffers.current.set(sessionId, '');
    const ws = new WebSocket('ws://127.0.0.1:8700/terminal'); socket.current = ws;
    sessionSockets.current.set(sessionId, ws);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connect', shell: targetShell, host: targetHost.trim(), username: targetUsername.trim(), port: sshPort, identityFile: targetIdentity.trim(), cols: term.current?.cols ?? 100, rows: term.current?.rows ?? 30 }));
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string; message?: string; exitCode?: number };
      if (message.type === 'data' && message.data) {
        const previous = terminalBuffers.current.get(sessionId) ?? '';
        terminalBuffers.current.set(sessionId, (previous + message.data).slice(-1_000_000));
        if (activeId === sessionId) term.current?.write(message.data);
      }
      if (message.type === 'status') {
        if (activeId === sessionId) setStatus('connected');
        setSessions(current => current.map(item => item.id === sessionId ? { ...item, title: targetShell === 'pwsh' ? 'Local PowerShell' : targetHost.trim(), host: targetHost.trim(), username: targetUsername.trim(), port: sshPort, identityFile: targetIdentity.trim(), shell: targetShell, updatedAt: Date.now() } : item));
        if (activeId === sessionId) term.current?.focus();
      }
      if (message.type === 'error' && activeId === sessionId) { setError(message.message ?? 'Unable to start terminal session.'); setStatus('error'); setShowConnect(true); }
      if (message.type === 'exit') {
        if (activeId === sessionId) { setStatus('idle'); term.current?.writeln('\r\n\x1b[90mTerminal session ended.\x1b[0m'); }
        sessionSockets.current.delete(sessionId);
      }
    };
    ws.onerror = () => { if (activeId === sessionId) { setError('Cannot reach the local SSH bridge. Start the app with npm run dev.'); setStatus('error'); setShowConnect(true); } };
    ws.onclose = () => { if (socket.current === ws) socket.current = null; if (sessionSockets.current.get(sessionId) === ws) sessionSockets.current.delete(sessionId); };
  };

  const newSession = () => {
    const item: SavedSession = { id: crypto.randomUUID(), title: 'New connection', host: '', username: '', port: 22, identityFile: '', updatedAt: Date.now() };
    setSessions(current => [item, ...current]); setActiveId(item.id); socket.current = null; setHost(''); setUsername(''); setPort('22'); setIdentityFile(''); setShell('ssh');
    setError(''); setStatus('idle'); setShowConnect(true);
  };
  const selectSession = (item: SavedSession) => {
    const existingSocket = sessionSockets.current.get(item.id);
    const isConnected = existingSocket?.readyState === WebSocket.OPEN;
    socket.current = existingSocket ?? null;
    setActiveId(item.id); setHost(item.host); setUsername(item.username); setPort(String(item.port)); setIdentityFile(item.identityFile); setShell(item.shell ?? 'ssh');
    setError(''); setStatus(isConnected ? 'connected' : 'idle'); setShowConnect(!isConnected);
  };

  const deleteSession = (id: string) => {
    const remaining = sessions.filter(item => item.id !== id);
    sessionSockets.current.get(id)?.close();
    sessionSockets.current.delete(id);
    terminalBuffers.current.delete(id);
    setSessions(remaining);
    if (activeId === id) {
      const next = remaining[0];
      socket.current = null; setStatus('idle'); setError(''); setShowConnect(true);
      setActiveId(next?.id ?? 'welcome');
      const nextSocket = next ? sessionSockets.current.get(next.id) : undefined;
      if (nextSocket?.readyState === WebSocket.OPEN) { socket.current = nextSocket; setStatus('connected'); setShowConnect(false); }
      setHost(next?.host ?? ''); setUsername(next?.username ?? '');
      setPort(String(next?.port ?? 22)); setIdentityFile(next?.identityFile ?? '');
      setShell(next?.shell ?? 'ssh');
    }
  };

  const startForwarding = () => {
    const saved = recentSshSessions.find(item => item.id === forwardHostId) ?? recentSshSessions[0];
    const remote = Number(remoteForwardPort);
    const local = Number(localForwardPort || remoteForwardPort);
    if (!saved) { setForwardError('Create a successful SSH connection first.'); return; }
    if (![remote, local].every(value => Number.isInteger(value) && value >= 1 && value <= 65535)) { setForwardError('Enter valid TCP ports between 1 and 65535.'); return; }
    forwardSocket.current?.close(); setForwardError(''); setForwardStatus('starting'); setForwardAddress(`127.0.0.1:${local}`);
    const ws = new WebSocket('ws://127.0.0.1:8700/forward'); forwardSocket.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', host: saved.host, username: saved.username, sshPort: saved.port, identityFile: saved.identityFile, remotePort: remote, localPort: local }));
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data)) as { type: string; message?: string };
      if (message.type === 'started') { setForwardStatus('active'); setActiveForward({ host: saved.host, username: saved.username, remotePort: remote, localPort: local }); }
      if (message.type === 'error') { setForwardError(message.message ?? 'Unable to start port forwarding.'); setForwardStatus('error'); }
      if (message.type === 'stopped') { setForwardStatus('idle'); setActiveForward(null); }
    };
    ws.onerror = () => { setForwardError('Cannot reach the local SSH bridge.'); setForwardStatus('error'); };
    ws.onclose = () => { if (forwardSocket.current === ws) { forwardSocket.current = null; setForwardStatus(current => current === 'active' || current === 'starting' ? 'idle' : current); } };
  };
  const stopForwarding = () => {
    const ws = forwardSocket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
    ws?.close(); forwardSocket.current = null; setForwardStatus('idle'); setForwardError(''); setActiveForward(null); setShowForwarding(false);
  };

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? '' : 'sidebar-hidden'}`}>
      <div className="brand"><div className="brand-mark"><SquareTerminal size={19}/></div><span>terminal</span><button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><Menu size={17}/></button></div>
      <button className="new-chat" onClick={newSession}><Plus size={17}/><span>New connection</span><span className="shortcut">⌘ K</span></button>
      <div className="side-label">YOUR SESSIONS</div>
      <div className="session-list">{sessions.map(item => <div key={item.id} className={`session-row ${item.id === activeId ? 'selected' : ''}`}><button type="button" className={`session-item ${item.id === activeId ? 'selected' : ''}`} onClick={() => selectSession(item)}><TerminalSquare size={15}/><span>{item.title || 'New connection'}</span></button><button type="button" className="session-delete" onClick={() => deleteSession(item.id)} aria-label={`Delete ${item.title || 'New connection'}`} title="Delete session"><Trash2 size={14}/></button></div>)}</div>
      <div className="sidebar-bottom">
        {activeForward && <button type="button" className={`sidebar-forwards ${showForwarding ? 'selected' : ''}`} onClick={() => setShowForwarding(true)} aria-label="Open SSH Port Forwarding settings"><span className="sidebar-forward-heading"><span className="state-dot live"/> ACTIVE PORT FORWARD</span><span className="sidebar-forward-row"><ArrowLeftRight size={14}/><span><strong>localhost:{activeForward.localPort}</strong><small>→ {activeForward.host}:{activeForward.remotePort}</small></span></span></button>}

      </div>
    </aside>
    <main className="main-panel">
      <header className="topbar">
        <div className="top-left">{!sidebarOpen && <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar"><Menu size={18}/></button>}<span className="breadcrumb">Workspace</span><span className="crumb-divider">/</span><strong>{active?.title || 'New connection'}</strong><ChevronDown size={14} className="muted-icon"/></div>
        <div className="top-right"><span className="bridge-state"><span className={`state-dot ${status === 'connected' ? 'live' : ''}`}/>{status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Local bridge'}</span></div>
      </header>
      <section className="terminal-workspace">
        <div className="workspace-heading"><div><div className="eyebrow"><span className="eyebrow-dot"/> INTERACTIVE SESSION</div><h1>{status === 'connected' && active?.title ? active.title : 'Your terminal, anywhere.'}</h1><p>A focused workspace for local PowerShell and remote SSH sessions.</p></div><div className="workspace-actions"><span className="clock">{clock}</span><button className="connect-button" onClick={() => { closeSocket(); setStatus('idle'); }}><Plus size={15}/> Connect</button></div></div>
        {showForwarding && activeForward && <div className="start-panels forwarding-detail-panels">
          <section className="recent-panel forward-panel forwarding-detail-card">
            <div className="start-panel-heading"><div className="start-panel-icon recent-icon"><ArrowLeftRight size={18}/></div><div><h2>SSH Port Forwarding</h2><p>Manage your active secure TCP tunnel</p></div></div>
            <label className="forward-label">SSH SERVER<input value={`${activeForward.username ? `${activeForward.username}@` : ''}${activeForward.host}`} readOnly/></label>
            <div className="forward-port-row"><label className="forward-label">REMOTE TCP PORT<input value={String(activeForward.remotePort)} readOnly/></label><div className="forward-arrow"><ArrowLeftRight size={17}/></div><label className="forward-label">LOCAL PORT<input value={String(activeForward.localPort)} readOnly/></label></div>
            <div className="forward-explainer"><ShieldCheck size={15}/><span>Secure tunnel: <b>localhost:{activeForward.localPort}</b> → remote service <b>127.0.0.1:{activeForward.remotePort}</b></span></div>
            <div className="forward-running"><span className="state-dot live"/> Forwarding active <b>localhost:{activeForward.localPort}</b></div>
            <button type="button" className="submit-button stop-forward-button" onClick={stopForwarding}><Square size={14}/> Stop Forwarding</button>
            <button type="button" className="forward-back-button" onClick={() => setShowForwarding(false)}>Back to terminal</button>
            <div className="recent-foot"><ShieldCheck size={14}/> SSH -L · Bound to 127.0.0.1 only</div>
          </section>
        </div>}
        {status !== 'connected' && !showForwarding && <div className="start-panels">
          <form className="start-connect-panel" onSubmit={connect}>
            <div className="start-panel-heading"><div className="start-panel-icon"><Plus size={18}/></div><div><h2>New connection</h2><p>Connect to a remote SSH server</p></div></div>
            <label>SHELL<select value={shell} onChange={e => setShell(e.target.value as 'ssh' | 'pwsh')}><option value="ssh">SSH · Remote server</option><option value="pwsh">PowerShell 7 · Local (pwsh.exe)</option></select></label>
            {shell === 'ssh' ? <>
              <label>HOST<input value={host} onChange={e => setHost(e.target.value)} placeholder="server.example.com"/></label>
              <div className="form-grid"><label>USERNAME<input value={username} onChange={e => setUsername(e.target.value)} placeholder="Optional"/></label><label>PORT<input value={port} onChange={e => setPort(e.target.value)} inputMode="numeric"/></label></div>
              <label>IDENTITY FILE<input value={identityFile} onChange={e => setIdentityFile(e.target.value)} placeholder="Optional · ~/.ssh/id_ed25519"/></label>
              <div className="ssh-note"><ShieldCheck size={15}/><span>Uses ssh.exe defaults, ~/.ssh/config and ssh-agent when no key is specified.</span></div>
            </> : <div className="ssh-note"><ShieldCheck size={15}/><span>Starts a local PowerShell 7 session on this machine.</span></div>}
            {error && <div className="error-message">{error}</div>}
            <button className="submit-button" type="submit" disabled={status === 'connecting'}>{status === 'connecting' ? 'Connecting…' : shell === 'pwsh' ? 'Start PowerShell' : 'Connect to SSH'} <span>↗</span></button>
          </form>
          <section className="recent-panel forward-panel">
            <div className="start-panel-heading"><div className="start-panel-icon recent-icon"><ArrowLeftRight size={18}/></div><div><h2>SSH Port Forwarding</h2><p>Expose a remote TCP service on this machine</p></div></div>
            <label className="forward-label">SSH SERVER<select value={forwardHostId || recentSshSessions[0]?.id || ''} onChange={e => setForwardHostId(e.target.value)} disabled={!recentSshSessions.length || forwardStatus === 'active' || forwardStatus === 'starting'}><option value="">{recentSshSessions.length ? 'Select a saved SSH connection' : 'No saved SSH connections yet'}</option>{recentSshSessions.map(item => <option key={item.id} value={item.id}>{item.username ? `${item.username}@` : ''}{item.host}{item.port !== 22 ? `:${item.port}` : ''}</option>)}</select></label>
            <div className="forward-port-row"><label className="forward-label">REMOTE TCP PORT<input type="number" min="1" max="65535" value={remoteForwardPort} onChange={e => setRemoteForwardPort(e.target.value)} placeholder="e.g. 5432" disabled={forwardStatus === 'active' || forwardStatus === 'starting'}/></label><div className="forward-arrow"><ArrowLeftRight size={17}/></div><label className="forward-label">LOCAL PORT<input type="number" min="1" max="65535" value={localForwardPort} onChange={e => setLocalForwardPort(e.target.value)} placeholder={remoteForwardPort || 'Same as remote'} disabled={forwardStatus === 'active' || forwardStatus === 'starting'}/></label></div>
            <div className="forward-explainer"><ShieldCheck size={15}/><span>Secure tunnel: <b>localhost:{localForwardPort || remoteForwardPort || '—'}</b> → remote service <b>127.0.0.1:{remoteForwardPort || '—'}</b></span></div>
            {forwardError && <div className="error-message">{forwardError}</div>}
            {forwardStatus === 'active' ? <div className="forward-running"><span className="state-dot live"/> Forwarding active <b>localhost:{forwardAddress.split(':').pop()}</b></div> : <div className="forward-idle"><span className="state-dot"/> {forwardStatus === 'starting' ? 'Starting SSH tunnel…' : 'No active tunnel'}</div>}
            {forwardStatus === 'active' ? <button type="button" className="submit-button stop-forward-button" onClick={stopForwarding}><Square size={14}/> Stop Forwarding</button> : <button type="button" className="submit-button" onClick={startForwarding} disabled={!recentSshSessions.length || forwardStatus === 'starting'}><Play size={14}/> {forwardStatus === 'starting' ? 'Starting…' : 'Start Forwarding'} <span>↗</span></button>}
            <div className="recent-foot"><ShieldCheck size={14}/> SSH -L · Bound to 127.0.0.1 only</div>
          </section>
        </div>}
        {status === 'connected' && !showForwarding && <div className="terminal-card">
          <div className="terminal-toolbar"><div className="window-controls"><i/><i/><i/></div><div className="terminal-caption"><Activity size={13}/><span>{active?.shell === 'pwsh' ? 'LOCAL POWERSHELL' : active?.host || 'LOCAL TERMINAL'}</span><span className="caption-separator">·</span><span>{status === 'connected' ? (active?.shell === 'pwsh' ? 'PWSH' : 'SSH') : 'AWAITING CONNECTION'}</span></div><button className="toolbar-button" onClick={() => term.current?.clear()} title="Clear terminal"><Command size={14}/></button></div>
          <div className="terminal-screen"><div className="terminal-mount" ref={terminalRef}/>{status !== 'connected' && !showConnect && <div className="terminal-empty"><div className="empty-glyph"><TerminalSquare size={24}/></div><strong>Ready when you are.</strong><span>Start a local shell or connect to a remote host.</span><button onClick={() => setShowConnect(true)}>Configure terminal session <Plus size={14}/></button></div>}</div>
          <div className="terminal-footer"><span><span className={`state-dot ${status === 'connected' ? 'live' : ''}`}/>{status === 'connected' ? 'SESSION ACTIVE' : 'AWAITING CONNECTION'}</span><span>xterm.js <b>·</b> UTF-8 <b>·</b> {status === 'connected' ? 'INTERACTIVE PTY' : 'LOCAL'}</span></div>
        </div>}
        {status === 'connected' && !showForwarding && <div className="hint-row"><span><kbd>Ctrl</kbd> + <kbd>C</kbd> <span>Interrupt process</span></span><span><kbd>Ctrl</kbd> + <kbd>L</kbd> <span>Clear screen</span></span><span><Monitor size={13}/> Resize-aware PTY</span></div>}
      </section>
      <footer className="page-footer"><span>Built for the command line.</span><span><span className="footer-dot"/> All traffic stays on your local machine until you connect.</span></footer>
    </main>
    {showConnect && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowConnect(false); }}>
      <form className="connect-modal" onSubmit={connect}>
        <div className="modal-head"><div className="modal-icon"><Server size={19}/></div><button type="button" className="icon-button" onClick={() => setShowConnect(false)} aria-label="Close"><X size={17}/></button></div>
        <div className="modal-title">Start a terminal session</div><p className="modal-description">Choose a local shell or connect to a remote SSH host.</p>
        <label>SHELL<select value={shell} onChange={e => setShell(e.target.value as 'ssh' | 'pwsh')}><option value="ssh">SSH · Remote server</option><option value="pwsh">PowerShell 7 · Local (pwsh.exe)</option></select></label>
        {shell === 'ssh' && <>
          <label>HOST<input autoFocus value={host} onChange={e => setHost(e.target.value)} placeholder="server.example.com"/></label>
          <div className="form-grid"><label>USERNAME<input value={username} onChange={e => setUsername(e.target.value)} placeholder="Optional"/></label><label>PORT<input value={port} onChange={e => setPort(e.target.value)} inputMode="numeric"/></label></div>
          <label>IDENTITY FILE<input value={identityFile} onChange={e => setIdentityFile(e.target.value)} placeholder="Optional · e.g. C:\\Users\\you\\.ssh\\id_ed25519"/></label>
          <div className="ssh-note"><ShieldCheck size={15}/><span>Leave identity file empty to use ssh.exe defaults, ~/.ssh/config and ssh-agent.</span></div>
        </>}
        {shell === 'pwsh' && <div className="ssh-note"><ShieldCheck size={15}/><span>Starts pwsh.exe on this Windows machine in your user profile directory. PowerShell profiles and interactive commands are enabled.</span></div>}
        {error && <div className="error-message">{error}</div>}
        <button className="submit-button" type="submit" disabled={status === 'connecting'}>{status === 'connecting' ? 'Starting…' : shell === 'pwsh' ? 'Start PowerShell' : 'Start SSH session'} <span>↗</span></button>
        <div className="modal-foot"><span><span className="online-dot"/> Local terminal bridge</span><span>{shell === 'pwsh' ? 'pwsh.exe · PowerShell 7' : 'ssh.exe · OpenSSH'}</span></div>
      </form>
    </div>}
  </div>;
}
