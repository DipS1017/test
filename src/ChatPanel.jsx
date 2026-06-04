import { useCallback, useEffect, useRef, useState } from 'react';

// Chat lives in the packager process (the dedicated livestream server), NOT the
// REST API — so it's a different port. Browsers can't set headers on a WS
// handshake, so the JWT rides as ?token=.
const CHAT_WS_BASE = 'ws://localhost:8095';

const QUICK_EMOJI = ['🔥', '🙏', '❤️', '😂', '👏', '🎉', '🙌', '✨'];

export function ChatPanel({ token, livestreamId }) {
  const [messages, setMessages] = useState([]);
  const [viewers, setViewers] = useState(0);
  const [status, setStatus] = useState('connecting');
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');

  const wsRef = useRef(null);
  const seenRef = useRef(new Set());
  const listRef = useRef(null);
  const retryRef = useRef(null);

  // dedupe by server id (history + live can overlap)
  const addMessages = useCallback((incoming) => {
    setMessages((prev) => {
      const next = [...prev];
      for (const m of incoming) {
        if (!m?.id || seenRef.current.has(m.id)) continue;
        seenRef.current.add(m.id);
        next.push(m);
      }
      return next.slice(-200);
    });
  }, []);

  useEffect(() => {
    if (!token || !livestreamId) return;
    let closed = false;

    const connect = () => {
      const url = `${CHAT_WS_BASE}/livestreams/${livestreamId}/chat/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      setStatus('connecting');

      // Guard: ignore events from a socket that's no longer the current one
      // (a stale socket from a StrictMode/reconnect cycle must not clobber state).
      const stale = () => ws !== wsRef.current;

      ws.onopen = () => { if (stale()) return; setStatus('connected'); };
      ws.onclose = () => {
        if (stale()) return;
        setStatus('disconnected');
        if (!closed) retryRef.current = setTimeout(connect, 2000); // auto-reconnect
      };
      ws.onerror = () => {};
      ws.onmessage = (e) => {
        if (stale()) return;
        let frame;
        try { frame = JSON.parse(e.data); } catch { return; }
        switch (frame.type) {
          case 'history': addMessages(frame.data || []); break;
          case 'message': addMessages([frame.data]); break;
          case 'viewer_count': setViewers(frame.data?.count ?? 0); break;
          case 'message_deleted':
            setMessages((prev) => prev.filter((m) => m.id !== frame.data?.message_id));
            break;
          case 'error':
            setNotice(frame.message || 'error');
            setTimeout(() => setNotice(''), 3000);
            break;
          default: break;
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retryRef.current);
      wsRef.current?.close();
      seenRef.current = new Set();
      setMessages([]);
    };
  }, [token, livestreamId, addMessages]);

  // keep scrolled to the latest message
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = (text) => {
    const content = (text ?? draft).trim();
    if (!content || wsRef.current?.readyState !== WebSocket.OPEN) return;
    // client_message_id for idempotency + (server-side) optimistic reconciliation
    wsRef.current.send(JSON.stringify({ id: crypto.randomUUID(), type: 'message', content }));
    setDraft('');
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <span className={`dot ${status === 'connected' ? 'live' : ''}`} />
        <span className="muted">{status}</span>
        <span className="chat-viewers">👁 {viewers}</span>
      </div>

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && <div className="muted" style={{ padding: 8 }}>No messages yet — say hi 👋</div>}
        {messages.map((m) => (
          <div className="chat-msg" key={m.id}>
            <Avatar sender={m.sender} />
            <div>
              <span className="chat-name">{m.sender?.name || 'unknown'}</span>
              <span className="chat-text">{m.content}</span>
            </div>
          </div>
        ))}
      </div>

      {notice && <div className="chat-notice">⚠ {notice}</div>}

      <div className="chat-emoji">
        {QUICK_EMOJI.map((e) => (
          <button key={e} className="emoji-btn" onClick={() => send(e)} title={`send ${e}`}>{e}</button>
        ))}
      </div>
      <div className="chat-input">
        <input
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={onKey}
          placeholder="Message (emoji welcome 🔥)…"
          maxLength={500}
        />
        <button onClick={() => send()} disabled={status !== 'connected'}>Send</button>
      </div>
    </div>
  );
}

function Avatar({ sender }) {
  if (sender?.profile_image) {
    return <img className="chat-avatar" src={sender.profile_image} alt="" />;
  }
  const initial = (sender?.name || '?').trim().charAt(0).toUpperCase();
  return <div className="chat-avatar chat-avatar-fallback">{initial}</div>;
}
