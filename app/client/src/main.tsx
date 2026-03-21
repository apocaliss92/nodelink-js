import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import "./app.css";

// Register Service Worker for PWA support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // In production, SW is at /static/sw.js, in dev it's at /sw.js
    const swPath = import.meta.env.PROD ? "/static/sw.js" : "/sw.js";
    navigator.serviceWorker
      .register(swPath)
      .then((registration) => {
        console.log("ServiceWorker registered:", registration.scope);

        // Check for updates periodically
        setInterval(
          () => {
            registration.update();
          },
          60 * 60 * 1000,
        ); // Check every hour
      })
      .catch((error) => {
        console.warn("ServiceWorker registration failed:", error);
      });
  });
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Missing #root element");
}

createRoot(rootEl).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
