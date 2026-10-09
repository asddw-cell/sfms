import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import AuthProvider from './auth/AuthProvider.jsx'
import { msalInstance } from './auth/msalConfig.js'
// Theme: swap between './index.css' (default) and './index-goliath.css' (branded)
import './index.css'

async function bootstrap() {
  // initialize() must complete before rendering so MSAL's internal state
  // (redirect response, cache hydration) is ready when the component tree mounts.
  // In dev mode msalInstance is null, so this branch is simply skipped.
  if (msalInstance) {
    await msalInstance.initialize()
  }

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>
  )
}

bootstrap()
