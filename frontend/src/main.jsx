import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AuthGate from './components/AuthGate.jsx'
import { DEMO } from './demoData'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {DEMO ? <App /> : <AuthGate><App /></AuthGate>}
  </StrictMode>,
)
