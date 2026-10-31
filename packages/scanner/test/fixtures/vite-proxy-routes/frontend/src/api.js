export const listTodos = () => fetch("/todos").then((r) => r.json());
export const login = (body) => fetch("/auth/login", { method: "POST", body: JSON.stringify(body) });
export const health = () => fetch("http://localhost:4000/health");
