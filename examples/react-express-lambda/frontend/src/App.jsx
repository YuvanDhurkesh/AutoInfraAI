import { useEffect, useState } from "react";

// Same origin in production (CloudFront sends /api/* to the backend).
const API = import.meta.env.VITE_API_URL || "/api";

export default function App() {
  const [notes, setNotes] = useState([]);
  const [health, setHealth] = useState(null);
  const [text, setText] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false }));
    fetch(`${API}/notes`)
      .then((r) => r.json())
      .then(setNotes)
      .catch(() => setError("Could not reach the API"));
  }, []);

  async function addNote(e) {
    e.preventDefault();
    setError(null);
    const res = await fetch(`${API}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
      return;
    }
    const note = await res.json();
    setNotes((prev) => [...prev, note]);
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
      <h1>Notes</h1>
      <p style={{ color: health?.ok ? "green" : "#b45309" }}>
        API:{" "}
        {health === null ? "checking..." : health.ok ? `up (${health.runtime})` : "unreachable"}
      </p>
      <form onSubmit={addNote} style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a note"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" style={{ padding: "8px 16px" }}>
          Add
        </button>
      </form>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <ul>
        {notes.map((n) => (
          <li key={n.id}>
            {n.text}{" "}
            <small style={{ color: "#64748b" }}>{new Date(n.createdAt).toLocaleString()}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
