/** The Rust build uses HTTP; the Pages build loads a private browser simulation. */
export const browserDemo = import.meta.env.MODE === 'pages';

export async function request(path: string, options: RequestInit = {}): Promise<Response> {
  if (options.signal?.aborted) throw new DOMException('Solicitud cancelada', 'AbortError');
  if (browserDemo) {
    const { demoRequest } = await import('./browser-demo');
    return demoRequest(path, options);
  }
  return fetch(path, options);
}

export async function resetBrowserDemo(): Promise<void> {
  if (browserDemo) (await import('./browser-demo')).resetDemo();
}

export async function exportCsv(path: string, filename: string): Promise<void> {
  const anchor = document.createElement('a');
  anchor.download = filename;
  if (!browserDemo) { anchor.href = path; anchor.click(); return; }
  const response = await request(path);
  if (!response.ok) throw new Error((await response.json()).message ?? 'No se pudo exportar');
  const url = URL.createObjectURL(await response.blob());
  anchor.href = url; anchor.click();
  // Keep the object URL alive until the browser has consumed the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
