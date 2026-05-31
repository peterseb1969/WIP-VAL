import { Outlet, NavLink, useLocation } from 'react-router-dom'

const NAV_ITEMS = [
  {
    path: '/',
    label: 'Manage Templates',
    isActive: (p: string) =>
      p === '/' || p === '/parse-template' || p.startsWith('/templates/'),
  },
  {
    path: '/validate',
    label: 'Validate Documents',
    isActive: (p: string) => p === '/validate',
  },
  {
    path: '/runs',
    label: 'Validation Runs',
    isActive: (p: string) => p === '/runs',
  },
]

function useBreadcrumb(): string {
  const { pathname } = useLocation()
  if (pathname === '/parse-template') return 'New Template'
  if (pathname.startsWith('/templates/')) return 'Template Detail'
  return ''
}

export default function Layout() {
  const crumb = useBreadcrumb()
  const { pathname } = useLocation()

  return (
    <>
      {/* Top bar */}
      <header className="bg-surface border-b border-gray-200 sticky top-0 z-20 h-14 flex items-center">
        <div className="px-4 sm:px-6 flex items-center gap-3 w-full">
          <span className="text-sm font-semibold text-primary">WIP-Val</span>
          {crumb && (
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <span>›</span>
              <span>{crumb}</span>
            </div>
          )}
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <nav className="hidden md:flex w-52 flex-col flex-shrink-0 border-r border-gray-200 bg-surface sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto">
          <ul className="py-3">
            {NAV_ITEMS.map(item => {
              const active = item.isActive(pathname)
              return (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    className={`flex items-center px-4 py-2.5 text-sm font-medium transition-colors border-l-2 ${
                      active
                        ? 'border-l-primary bg-primary/5 text-primary'
                        : 'border-l-transparent text-text hover:bg-gray-50'
                    }`}
                  >
                    {item.label}
                  </NavLink>
                </li>
              )
            })}
          </ul>
        </nav>

        {/* Main content */}
        <div className="flex-1 min-w-0 flex flex-col">
          <Outlet />
          {/* Local footer — @wip/react 0.9.0 has no WipFooter (added in 0.13.0,
              which is no longer available locally). Swap back if it returns. */}
          <footer className="mt-auto border-t border-gray-200 px-4 sm:px-6 py-3 text-xs text-text-muted">
            WIP-Val · powered by World In a Pie
          </footer>
        </div>
      </div>
    </>
  )
}
