export async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}${path}`);
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return response.json();
}
