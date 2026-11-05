export async function jsonRequest(url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, { ...options, signal: options.signal || AbortSignal.timeout(25000), redirect: 'error' });
  if (!response.ok) {
    const error = new Error(`HTTP_${response.status}: ${new URL(url).hostname}${new URL(url).pathname}`);
    error.status = response.status; throw error;
  }
  return response.json();
}
