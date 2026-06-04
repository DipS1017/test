import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { whipPublish } from './whip.js';
import { ChatPanel } from './ChatPanel.jsx';

// Injected by setup.sh into .env.local (Vite exposes VITE_* to the browser).
const CFG = {
  channelId: import.meta.env.VITE_CHANNEL_ID || '',
  email: import.meta.env.VITE_DEV_EMAIL || '',
  password: import.meta.env.VITE_DEV_PASSWORD || '',
};

// Thin REST helper. All API calls go through Vite's /api proxy → :8090.
async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || json?.error || `HTTP ${res.status}`);
  return json.payload ?? json;
}

export default function App() {
  return (
    <div className="page">
      <h1>WePreach — Livestream flow (local)</h1>
      <p className="sub">
        A throwaway UI to watch the whole flow happen. Each panel is one step.
        Open the browser console + the packager log to see the other side.
      </p>
      <Flow />
    </div>
  );
}

function Flow() {
  const [token, setToken] = useState('');
  const [stream, setStream] = useState(null);     // create response
  const [detail, setDetail] = useState(null);     // public detail (polled)
  const [err, setErr] = useState('');

  // ---- poll public detail once we have a stream, so we SEE is_live flip ----
  useEffect(() => {
    if (!stream?.id) return;
    let alive = true;
    const tick = () =>
      api(`/public/livestreams/${stream.id}`)
        .then((d) => alive && setDetail(d))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [stream?.id]);

  const guard = (fn) => async (...a) => {
    setErr('');
    try { await fn(...a); } catch (e) { setErr(String(e.message || e)); }
  };

  // ?stream=<id> lets a second tab join the SAME chat room (multi-client test)
  // without creating its own stream. Falls back to this tab's created stream.
  const chatRoom = new URLSearchParams(window.location.search).get('stream') || stream?.id;

  return (
    <>
      {err && <div className="err">⚠ {err}</div>}

      <Step n="1" title="Log in" done={!!token}>
        <LoginPanel onToken={setToken} guard={guard} />
      </Step>

      <Step n="2" title="Create a livestream (REST → your API)" done={!!stream}>
        <CreatePanel token={token} onCreated={setStream} guard={guard} />
        {stream && <CreatedInfo stream={stream} />}
      </Step>

      <Step n="3" title="Go live (push video → MediaMTX, NOT your API)" done={detail?.is_live}>
        {stream
          ? <BroadcastPanel stream={stream} guard={guard} />
          : <Muted>create a stream first ↑</Muted>}
      </Step>

      <Step n="4" title="Watch it (HLS playback ← S3/MinIO)" done={detail?.is_live}>
        {stream ? <ViewerPanel token={token} stream={stream} detail={detail} guard={guard} />
                : <Muted>create a stream first ↑</Muted>}
      </Step>

      <Step n="5" title="Live chat (WebSocket ← packager :8095)" done={!!chatRoom}>
        {chatRoom && token
          ? <ChatPanel token={token} livestreamId={chatRoom} />
          : <Muted>log in + create a stream first ↑ (or open ?stream=&lt;id&gt; to join an existing room)</Muted>}
      </Step>
    </>
  );
}

function LoginPanel({ onToken, guard }) {
  const [email, setEmail] = useState(CFG.email);
  const [password, setPassword] = useState(CFG.password);
  const login = guard(async () => {
    const r = await api('/auth/login', {
      method: 'POST',
      body: { email, password, is_admin: false, remember_me: true },
    });
    onToken(r.access_token);
  });
  return (
    <div className="row">
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
      <input value={password} type="password" onChange={(e) => setPassword(e.target.value)} placeholder="password" />
      <button onClick={login}>Log in</button>
      <Muted>prefilled with the dev user setup.sh created</Muted>
    </div>
  );
}

function CreatePanel({ token, onCreated, guard }) {
  const [name, setName] = useState('My Test Stream');
  const create = guard(async () => {
    const r = await api('/livestreams', {
      method: 'POST', token,
      body: { name, channel_id: CFG.channelId, visibility: 'public' },
    });
    onCreated(r);
  });
  return (
    <div className="row">
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <button disabled={!token} onClick={create}>Create</button>
      <Muted>channel: {CFG.channelId || '(missing — run setup.sh)'}</Muted>
    </div>
  );
}

function CreatedInfo({ stream }) {
  return (
    <div className="card">
      <div>The API just inserted a row and handed back a <b>key</b> — no video yet:</div>
      <KV k="id" v={stream.id} />
      <KV k="stream_key" v={stream.stream_key} secret />
      <KV k="is_live" v={String(stream.is_live)} />
      <KV k="rtmp (OBS)" v={stream.rtmp_ingest_url || stream.publish_endpoints?.rtmp} />
      <KV k="whip (webcam)" v={stream.publish_endpoints?.whip} />
    </div>
  );
}

function BroadcastPanel({ stream, guard }) {
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const [live, setLive] = useState(false);

  const goLive = guard(async () => {
    const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (videoRef.current) videoRef.current.srcObject = media; // local preview
    pcRef.current = await whipPublish(stream.publish_endpoints.whip, media);
    setLive(true);
  });

  const stop = () => {
    pcRef.current?.close();
    pcRef.current = null;
    const m = videoRef.current?.srcObject;
    m?.getTracks?.().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setLive(false);
  };

  useEffect(() => () => stop(), []); // cleanup on unmount

  return (
    <div>
      <div className="row">
        <button onClick={goLive} disabled={live}>📷 Go live from webcam (WHIP)</button>
        {live && <button onClick={stop} className="danger">Stop</button>}
        <Muted>this POSTs your webcam to {stream.publish_endpoints?.whip}</Muted>
      </div>
      <video ref={videoRef} autoPlay muted playsInline width="360" className="preview" />
      <div className="card">
        <b>…or use OBS:</b> Settings → Stream → Custom →
        <KV k="Server" v={obsServer(stream)} />
        <KV k="Stream Key" v={stream.stream_key} secret />
        <Muted>Then hit “Start Streaming”. The packager will notice within ~2s.</Muted>
      </div>
    </div>
  );
}

function ViewerPanel({ token, stream, detail, guard }) {
  const videoRef = useRef(null);
  const isLive = detail?.is_live;
  const url = detail?.live_hls_url;

  useEffect(() => {
    const video = videoRef.current;
    if (!url || !video) return;

    // Safari plays HLS natively.
    if (!Hls.isSupported()) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = url;
      return;
    }

    // IMPORTANT: is_live flips true the instant the packager starts, but the
    // first segment + master.m3u8 don't land in S3 for ~4–8s. So the manifest
    // 404s briefly at the live edge. hls.js gives up on a fatal manifest error,
    // so we tear down and retry until the HLS appears (what real players do).
    let hls;
    let retry;
    let dead = false;
    const attach = () => {
      if (dead) return;
      hls = new Hls({ liveSyncDuration: 6 });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        hls.destroy();
        if (!dead) retry = setTimeout(attach, 2000); // wait for HLS to appear
      });
    };
    attach();

    return () => {
      dead = true;
      clearTimeout(retry);
      hls?.destroy();
    };
  }, [url]);

  const end = guard(async () => {
    await api(`/livestreams/${stream.id}/end`, { method: 'POST', token });
  });

  return (
    <div>
      <div className="statusline">
        <span className={isLive ? 'dot live' : 'dot'} />
        is_live: <b>{String(!!isLive)}</b>
        {isLive && <button onClick={end} className="danger sm">Force end</button>}
        <Muted>(polled every 3s — this is the “no websocket” part)</Muted>
      </div>
      {isLive && url ? (
        <video ref={videoRef} controls autoPlay muted playsInline width="480" className="preview" />
      ) : (
        <Muted>waiting for the packager to flip is_live and write HLS to S3…</Muted>
      )}
      {url && <KV k="live_hls_url" v={url} />}
    </div>
  );
}

// ---- tiny presentational helpers ----
function Step({ n, title, done, children }) {
  return (
    <section className={`step ${done ? 'ok' : ''}`}>
      <h2><span className="num">{done ? '✓' : n}</span> {title}</h2>
      {children}
    </section>
  );
}
const Muted = ({ children }) => <span className="muted">{children}</span>;
function KV({ k, v, secret }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <code className={secret ? 'secret' : ''}>{v || '—'}</code>
    </div>
  );
}
function obsServer(stream) {
  const rtmp = stream.rtmp_ingest_url || stream.publish_endpoints?.rtmp || '';
  // OBS wants the server (without the key) and the key separately.
  return rtmp.replace(new RegExp(`/${stream.stream_key}$`), '');
}
