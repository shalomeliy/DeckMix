import { Component, type ReactNode } from 'react'

/**
 * v0.9.61: the four full-screen panels are fetched when opened. If that fetch fails (typically a rebuild while the page was
 * open: hashed chunk names changed and the old page asks for files that are gone) React would unmount the whole app mid-set.
 * This keeps the failure to the panel and says it out loud — the project's "never skip silently" rule.
 */
export class PanelLoadBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="fixed inset-x-0 top-12 z-50 mx-auto w-fit rounded-[var(--radius-xs)] border border-[var(--color-warn,#f5a524)] bg-[var(--color-surface-1,#14161d)] px-4 py-2 text-sm text-[var(--color-text,#fff)]">
        This screen could not be loaded — the app was probably updated while it was open. Reload the page (F5) and open it again.{' '}
        <button className="ml-2 underline" onClick={() => { this.setState({ failed: false }); this.props.onClose() }}>
          Dismiss
        </button>
      </div>
    )
  }
}
