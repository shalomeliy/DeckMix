/**
 * File System Access writer for v0.8.3's setlist export — same shape as
 * `recorder-fsaccess/writer.ts`'s `saveMasterRecording`: a NEW file the
 * owner picks in a save dialog, never an existing one. `AbortError` (the
 * owner closing the dialog) is `'cancelled'`, a normal outcome, not
 * something `controls.ts` turns into a notice.
 */
const TEXT_FILE_TYPES = [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }]

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: { description: string; accept: Record<string, string[]> }[]
}

function getSaveFilePicker(): ((o?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>) | undefined {
  return (window as unknown as { showSaveFilePicker?: (o?: SaveFilePickerOptions) => Promise<FileSystemFileHandle> })
    .showSaveFilePicker
}

export async function saveSetHistoryText(text: string, suggestedName: string): Promise<'ok' | 'cancelled'> {
  const picker = getSaveFilePicker()
  if (typeof picker !== 'function') throw new Error('this browser has no file save dialog')
  let handle: FileSystemFileHandle
  try {
    handle = await picker({ suggestedName, types: TEXT_FILE_TYPES })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    throw err
  }
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
  return 'ok'
}

const JSON_FILE_TYPES = [{ description: 'JSON file', accept: { 'application/json': ['.json'] } }]

/** v0.9.0's tag export — the same new-file-only rule as the setlist above. */
export async function saveTagsJson(text: string, suggestedName: string): Promise<'ok' | 'cancelled'> {
  const picker = getSaveFilePicker()
  if (typeof picker !== 'function') throw new Error('this browser has no file save dialog')
  let handle: FileSystemFileHandle
  try {
    handle = await picker({ suggestedName, types: JSON_FILE_TYPES })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    throw err
  }
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
  return 'ok'
}

/** v0.13.0's mix log export — a NEW file the owner names, same rule as the tag export above. */
export async function saveMixLogJson(text: string, suggestedName: string): Promise<'ok' | 'cancelled'> {
  return saveTagsJson(text, suggestedName)
}
