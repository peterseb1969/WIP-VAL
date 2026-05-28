import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import TemplateList from './pages/TemplateList'
import TemplateParser from './pages/TemplateParser'
import TemplateDetail from './pages/TemplateDetail'
import ValidateDocuments from './pages/ValidateDocuments'
import ValidationRuns from './pages/ValidationRuns'
import AskBar from './components/AskBar'

export default function App() {
  return (
    <BrowserRouter>
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
  )
}
