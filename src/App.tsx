import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useAppSessionRenewal } from '@wip/react'
import BootstrapGate from './components/BootstrapGate'
import Layout from './components/Layout'
import TemplateList from './pages/TemplateList'
import TemplateParser from './pages/TemplateParser'
import TemplateDetail from './pages/TemplateDetail'
import ValidateDocuments from './pages/ValidateDocuments'
import ValidationRuns from './pages/ValidationRuns'
import AskBar from './components/AskBar'

export default function App() {
  // Behind the WIP gateway the app's origin holds a short-lived session
  // (15 min by default) that background fetches cannot renew on their own.
  // The app has no WipProvider (its server talks to WIP), so it calls the
  // renewal hook directly. With no gateway (local dev) it retries quietly.
  useAppSessionRenewal()

  return (
    <BootstrapGate>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<TemplateList />} />
            <Route path="/parse-template" element={<TemplateParser />} />
            <Route path="/templates/:id" element={<TemplateDetail />} />
            <Route path="/validate" element={<ValidateDocuments />} />
            <Route path="/runs" element={<ValidationRuns />} />
          </Route>
        </Routes>
        <AskBar />
      </BrowserRouter>
    </BootstrapGate>
  )
}
