import { Route, Routes } from "react-router-dom";
import axios from "axios";
import io from "socket.io-client";

const ENDPOINT = "http://localhost:5000";
export const socket = io(ENDPOINT);

export const fetchChats = () => axios.get("/api/chat");
export const avatarUrl = (file) => `${ENDPOINT}/uploads/${file}`;

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<div>Home</div>} />
      <Route path="/chats" element={<div>Chats</div>} />
    </Routes>
  );
}
