import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { storageMoveNotice } from '@/core/storage-rename'
import { migrateLegacyStorage } from '@/platform/storage-rename/migrate'

// The app is imported only after old `soundgrid:` keys have moved to their
// `deckmix:` names (v0.8.20). Several stores read storage the moment their
// module loads, so a static import here would read before the move and find
// nothing. See `platform/storage-rename/migrate.ts`.
void migrateLegacyStorage().then(async (moveResult) => {
  const [{ default: App }, { useStore }] = await Promise.all([import('@/app/App'), import('@/app/state/store')])
  const notice = storageMoveNotice(moveResult)
  if (notice) useStore.getState().set('storageNotice', notice)
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
