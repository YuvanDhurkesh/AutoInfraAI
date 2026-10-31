import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<p>Todos</p>} />
      <Route path="/settings" element={<p>Settings</p>} />
    </Routes>
  </BrowserRouter>,
);
