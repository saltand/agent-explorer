import { useEffect } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useSessionStore } from '../../store/sessionStore'
import { ConversationPanel } from '../conversation/ConversationPanel'
import { DetailPanel } from '../detail/DetailPanel'
import { LibraryPanel } from '../library/LibraryPanel'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { StatusBar } from '../status/StatusBar'
import { FileDropOverlay } from './FileDropOverlay'
import { LibrarySidebar } from './LibrarySidebar'
import { ResizableLayout } from './ResizableLayout'

export function AppShell() {
  const theme = useSessionStore((s) => s.theme)
  const setTheme = useSessionStore((s) => s.setTheme)
  const serverStatus = useLibraryStore((s) => s.status)
  const connect = useLibraryStore((s) => s.connect)
  const libraryOpen = useSessionStore((s) => s.libraryOpen)

  useEffect(() => {
    setTheme(theme)
  }, [theme, setTheme])

  // Detect the local CLI once on mount; static hosting just stays offline.
  useEffect(() => {
    void connect()
  }, [connect])

  return (
    <FileDropOverlay>
      <div className="flex h-full w-full flex-col">
        <StatusBar />
        <div className="flex min-h-0 flex-1">
          <LibrarySidebar open={libraryOpen && serverStatus !== 'offline'}>
            <LibraryPanel />
          </LibrarySidebar>
          <div className="flex h-full min-w-0 flex-1 flex-col">
            <ResizableLayout
              timeline={<TimelinePanel />}
              conversation={<ConversationPanel />}
              detail={<DetailPanel />}
            />
          </div>
        </div>
      </div>
    </FileDropOverlay>
  )
}
