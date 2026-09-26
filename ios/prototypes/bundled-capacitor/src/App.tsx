import { useState } from 'react';

import './style.css';

const storageKey = 'gooncave-prototype-server';

function parseServer(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '')
    ) return null;
    return url;
  } catch {
    return null;
  }
}

type FileSummary = {
  id: string;
  mediaType: 'IMAGE' | 'VIDEO';
};

function isFileSummary(value: unknown): value is FileSummary {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return typeof file.id === 'string' &&
    (file.mediaType === 'IMAGE' || file.mediaType === 'VIDEO');
}

export function App() {
  const [address, setAddress] = useState(() => localStorage.getItem(storageKey) ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('Enter the same HTTPS server used by the remote shell.');
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [imageId, setImageId] = useState('');
  const [videoId, setVideoId] = useState('');
  const server = parseServer(address);

  async function request(path: string, init?: RequestInit): Promise<Response> {
    if (!server) throw new Error('Enter a valid HTTPS server address first.');
    return fetch(new URL(path, server), { ...init, credentials: 'include' });
  }

  async function checkSession() {
    try {
      const response = await request('/auth/me');
      setStatus(response.ok ? 'Session request succeeded.' : `Session request returned HTTP ${response.status}.`);
    } catch (error) {
      setStatus(`Session request failed: ${String(error)}`);
    }
  }

  async function login() {
    try {
      const response = await request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      setPassword('');
      setStatus(response.ok ? 'Login response succeeded. Check the session next.' : `Login returned HTTP ${response.status}.`);
    } catch (error) {
      setPassword('');
      setStatus(`Login request failed: ${String(error)}`);
    }
  }

  async function loadFiles() {
    try {
      const response = await request('/files?limit=20');
      if (!response.ok) {
        setStatus(`File list returned HTTP ${response.status}.`);
        return;
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('files' in data) ||
          !Array.isArray(data.files) || !data.files.every(isFileSummary)) {
        setStatus('The server returned an unexpected file list.');
        return;
      }
      setFiles(data.files);
      setImageId(data.files.find((file) => file.mediaType === 'IMAGE')?.id ?? '');
      setVideoId(data.files.find((file) => file.mediaType === 'VIDEO')?.id ?? '');
      setStatus(`Loaded ${data.files.length} file summaries. Media requests run through the WebView.`);
    } catch (error) {
      setStatus(`File list failed: ${String(error)}`);
    }
  }

  function saveServer() {
    if (!server) return;
    localStorage.setItem(storageKey, server.href);
    setStatus('Server address saved on this device.');
    setFiles([]);
    setImageId('');
    setVideoId('');
  }

  return (
    <main>
      <h1>Bundled React transport test</h1>
      <p>The page is inside this IPA. API and media requests go to your server.</p>
      <label>Server HTTPS address
        <input type="url" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="https://gooncave.example" autoCapitalize="none" />
      </label>
      <button type="button" disabled={!server} onClick={saveServer}>Save server</button>
      <label>Username
        <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
      </label>
      <label>Password
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
      </label>
      <div className="actions">
        <button type="button" disabled={!server || !username || !password} onClick={() => void login()}>Log in</button>
        <button type="button" disabled={!server} onClick={() => void checkSession()}>Check session</button>
        <button type="button" disabled={!server} onClick={() => void loadFiles()}>Load files</button>
      </div>
      <output role="status">{status}</output>
      <p>{files.length} file summaries loaded. Enter a known ID if the first page lacks the media type you need.</p>
      <label>Image file ID
        <input value={imageId} onChange={(event) => setImageId(event.target.value)} />
      </label>
      {server && imageId ? <section><h2>Protected image</h2><img alt="Protected file test" src={new URL(`/files/${encodeURIComponent(imageId)}/content`, server).href} onError={() => setStatus('Image request failed.')} /></section> : null}
      <label>Video file ID
        <input value={videoId} onChange={(event) => setVideoId(event.target.value)} />
      </label>
      {server && videoId ? <section><h2>Protected video</h2><video controls playsInline src={new URL(`/files/${encodeURIComponent(videoId)}/content`, server).href} onError={() => setStatus('Video request failed.')} /></section> : null}
      <p>This probe does not replace the existing React interface. It tests the cross-origin login and media contract before integrating that interface.</p>
    </main>
  );
}
