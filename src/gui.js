import "./runtime-guard.js";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { startGui } from "./gui-server.js";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    "no-open": { type: "boolean" },
    background: { type: "boolean" },
    desktop: { type: "boolean" },
  },
});

startGui({
  ...(values.config ? { configFile: path.resolve(values.config) } : {}),
  open: !values["no-open"],
  background: !!values.background,
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
  if (!values.desktop || process.platform !== "win32") return;
  const script =
    "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:ANIBT_GUI_STARTUP_MESSAGE, 'AniBT') | Out-Null";
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, ANIBT_GUI_STARTUP_MESSAGE: error.message },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.once("error", () => {});
});
