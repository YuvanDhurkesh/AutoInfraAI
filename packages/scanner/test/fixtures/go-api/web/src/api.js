export const notes = () => fetch(`${import.meta.env.VITE_API_URL}/notes`).then((r) => r.json());
