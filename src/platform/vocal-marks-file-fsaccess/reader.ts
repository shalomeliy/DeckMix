/**
 * Reads ONE file the owner picks (v0.9.10b: his vocal-marks backup). Read-only: the app never writes to a file that already exists.
 * `null` = he closed the dialog, a normal outcome; anything else that goes wrong throws and the caller says so on screen.
 */
export async function pickJsonFileText(): Promise<string | null> {
  const picker = (
    window as unknown as {
      showOpenFilePicker?: (o?: { multiple?: boolean; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle[]>
    }
  ).showOpenFilePicker
  if (typeof picker !== 'function') throw new Error('this browser has no file open dialog')
  let handles: FileSystemFileHandle[]
  try {
    handles = await picker({ multiple: false, types: [{ description: 'JSON file', accept: { 'application/json': ['.json'] } }] })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
  return (await handles[0].getFile()).text()
}
