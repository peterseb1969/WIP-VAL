import { useCallback, useEffect, useState } from 'react'

const BASE_PATH = import.meta.env.BASE_URL || '/'

type GateState = 'checking' | 'ready' | 'needs_bootstrap' | 'wip_unreachable' | 'running' | 'failed'

interface Step {
  step: string
  detail: string
}

// Blocks the app until the wip-val namespace exists on the connected WIP
// instance. On a fresh instance it offers a one-click idempotent bootstrap
// (POST /api/bootstrap/run provisions namespace + terminologies + templates
// from the data-model/ seeds).
export default function BootstrapGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('checking')
  const [detail, setDetail] = useState('')
  const [steps, setSteps] = useState<Step[]>([])

  const check = useCallback(() => {
    setState('checking')
    fetch(`${BASE_PATH}api/bootstrap/status`)
      .then(r => r.json())
      .then((d: { status: GateState; detail?: string }) => {
        setState(d.status)
        setDetail(d.detail ?? '')
      })
      .catch(err => {
        setState('wip_unreachable')
        setDetail(String(err))
      })
  }, [])

  useEffect(check, [check])

  const run = async () => {
    setState('running')
    setSteps([])
    try {
      const res = await fetch(`${BASE_PATH}api/bootstrap/run`, { method: 'POST' })
      const d = await res.json()
      setSteps(d.steps ?? [])
      if (d.ok) {
        check()
      } else {
        setState('failed')
        setDetail(d.error ?? 'Bootstrap failed')
      }
    } catch (err) {
      setState('failed')
      setDetail(String(err))
    }
  }

  if (state === 'ready') return <>{children}</>
  if (state === 'checking') return null

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-lg border border-gray-200 p-8">
        <h1 className="text-xl font-semibold text-gray-900 mb-2">WIP-VAL Setup</h1>

        {state === 'wip_unreachable' && (
          <>
            <p className="text-sm text-gray-600 mb-4">
              The WIP instance is not reachable (or rejected the API key). Check that WIP is
              running and the server&apos;s <code className="text-xs bg-gray-100 px-1 rounded">WIP_API_KEY</code> is valid.
            </p>
            {detail && <p className="text-xs text-red-600 font-mono mb-4 break-all">{detail}</p>}
            <button
              onClick={check}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              Retry
            </button>
          </>
        )}

        {state === 'needs_bootstrap' && (
          <>
            <p className="text-sm text-gray-600 mb-4">
              The <code className="text-xs bg-gray-100 px-1 rounded">wip-val</code> namespace does
              not exist on this WIP instance yet. Bootstrap provisions the namespace,
              terminologies, and templates from the bundled seed files. It is idempotent — safe
              to run again at any time.
            </p>
            <button
              onClick={run}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              Bootstrap
            </button>
          </>
        )}

        {state === 'running' && (
          <p className="text-sm text-gray-600 mb-4">Provisioning… this takes a few seconds.</p>
        )}

        {state === 'failed' && (
          <>
            <p className="text-sm text-red-600 mb-2">Bootstrap failed: {detail}</p>
            <button
              onClick={run}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 mb-4"
            >
              Retry
            </button>
          </>
        )}

        {steps.length > 0 && (
          <ul className="mt-4 text-xs font-mono text-gray-500 space-y-1 max-h-48 overflow-y-auto">
            {steps.map((s, i) => (
              <li key={i}>
                [{s.step}] {s.detail}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
