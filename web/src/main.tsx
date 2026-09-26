import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { installUndoKeys } from "@/lib/edit-keys"
import { installDesktopApi } from "@/lib/notify"

installDesktopApi()
installUndoKeys()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <App />
        <Toaster position="bottom-right" closeButton />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
)
