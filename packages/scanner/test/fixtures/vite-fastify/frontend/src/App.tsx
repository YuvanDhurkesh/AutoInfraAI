export function App() {
  const apiUrl = import.meta.env.VITE_API_URL;
  return <div>{apiUrl}</div>;
}
