import { useEffect, useState } from "react";

// Same origin in production (CloudFront sends /api/* to the backend).
const API = import.meta.env.VITE_API_URL || "/api";

export default function App() {
  const [messages, setMessages] = useState([]);
  const [online, setOnline] = useState(0);
  const [live, setLive] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API}/messages`)
      .then((r) => r.json())
      .then(setMessages)
      .catch(() => setError("Could not reach the API"));

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}${API}/ws`);
    socket.onopen = () => setLive(true);
    socket.onclose = () => setLive(false);
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "online") setOnline(data.count);
      if (data.type === "message") {
        setMessages((prev) =>
          prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message],
        );
      }
    };
    return () => socket.close();
  }, []);

  async function send(e) {
    e.preventDefault();
    setError(null);
    const res = await fetch(`${API}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
      return;
    }
    setText("");
  }

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 560,
        margin: "64px auto",
        padding: "0 16px",
      }}
    >
      <h1>Chat</h1>
      <p style={{ color: live ? "green" : "#b45309" }}>
        {live ? `Live -- ${online} online` : "Connecting..."}
      </p>
      <ul>
        {messages.map((m) => (
          <li key={m.id}>
            {m.text}{" "}
            <small style={{ color: "#64748b" }}>{new Date(m.createdAt).toLocaleTimeString()}</small>
          </li>
        ))}
      </ul>
      <form onSubmit={send} style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Say something"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" style={{ padding: "8px 16px" }}>
          Send
        </button>
      </form>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}
