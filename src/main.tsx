import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyAppTheme, readPersistedAppTheme } from "./utils/theme";
import "./index.css";

applyAppTheme(readPersistedAppTheme(), document.documentElement);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
