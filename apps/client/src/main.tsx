import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { TestLab } from "./TestLab";
import "./styles.css";

const url = new URL(window.location.href);
const useLab = url.searchParams.get("lab") === "1";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {useLab ? <TestLab /> : <App />}
  </React.StrictMode>,
);
